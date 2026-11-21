import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpConfigService } from '../src/mail/smtp-config.service.js';
import { DeliveriesService } from '../src/notifications/deliveries.service.js';
import { DeliveryQueue } from '../src/notifications/delivery-queue.js';
import { createEnrollment, createOutboxEvent, createStudent } from './utils/factories.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// The sweep of pending deliveries (research.md R-4) and the promise of SC-004: with push and email
// down every notice is still in the app, and what was pending is completed once they recover.
describe('notifications: sweep of pending deliveries', () => {
  let ctx: TestContext;
  let deliveries: DeliveriesService;

  beforeAll(async () => {
    ctx = await createTestApp();
    deliveries = ctx.app.get(DeliveriesService);
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  async function scenario(enrolled = 2) {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id);
    // `start` freezes the clock in 2030; the rows get their dates from the real time, so the sweep
    // (which compares them with the clock) needs the clock back on it.
    ctx.clock.reset();
    const students = [];
    for (let i = 0; i < enrolled; i++) {
      const student = await createStudent(ctx.prisma);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      students.push(student);
    }
    await createOutboxEvent(ctx.prisma, {
      type: 'SESSION_CANCELLED_TEACHER',
      moduleId: m.module.id,
      payload: { scope: 'SESSION', sessions: [{ sessionId: m.sessions[0][0].id, from: m.sessions[0][0].startsAt.toISOString() }] },
    });
    return { m, students };
  }
  // A moment later than the sweep age, so what was just created counts as "a while ago".
  const later = () => ctx.clock.advance(61_000);
  const pending = (channel?: 'PUSH' | 'EMAIL') =>
    ctx.prisma.notificationDelivery.count({ where: { status: 'PENDING', ...(channel && { channel }) } });
  // What the worker would do with each queued job.
  async function runQueued() {
    const jobs = ctx.deliveryQueue.jobs.splice(0);
    for (const job of jobs) {
      await (job.channel === 'PUSH' ? deliveries.deliverPush(job.id) : deliveries.deliverEmail(job.id)).catch(() => undefined);
    }
    return jobs.length;
  }

  it('puts back in the queue the deliveries left pending when the queue was down', async () => {
    await scenario();
    ctx.deliveryQueue.failNext = 1;
    await ctx.runOutbox();
    expect(ctx.deliveryQueue.jobs).toHaveLength(0);

    later();
    expect(await deliveries.sweep()).toBe(4);
    expect(ctx.deliveryQueue.jobs).toHaveLength(4);
    expect(new Set(ctx.deliveryQueue.jobs.map((j) => j.id)).size).toBe(4);
  });

  it('leaves alone the deliveries created a moment ago, whose job is probably alive', async () => {
    await scenario();
    ctx.deliveryQueue.failNext = 1;
    await ctx.runOutbox();
    expect(await deliveries.sweep()).toBe(0);
  });

  it('never queues a delivery that is already sent, skipped or failed', async () => {
    await scenario();
    await ctx.runOutbox();
    ctx.deliveryQueue.reset();
    const [sent, skipped, failed] = await ctx.prisma.notificationDelivery.findMany({ take: 3 });
    await ctx.prisma.notificationDelivery.update({ where: { id: sent.id }, data: { status: 'SENT' } });
    await ctx.prisma.notificationDelivery.update({ where: { id: skipped.id }, data: { status: 'SKIPPED' } });
    await ctx.prisma.notificationDelivery.update({ where: { id: failed.id }, data: { status: 'FAILED' } });
    later();
    await deliveries.sweep();
    expect(ctx.deliveryQueue.jobs.map((j) => j.id)).not.toContain(sent.id);
    expect(ctx.deliveryQueue.jobs.map((j) => j.id)).not.toContain(skipped.id);
    expect(ctx.deliveryQueue.jobs.map((j) => j.id)).not.toContain(failed.id);
    expect(ctx.deliveryQueue.jobs).toHaveLength(1);
  });

  it('keeps the emails out of the queue while there is no mail server, and takes them up once there is', async () => {
    await scenario();
    ctx.deliveryQueue.failNext = 1;
    await ctx.runOutbox();
    later();
    const resolve = vi.spyOn(ctx.app.get(SmtpConfigService), 'resolve').mockResolvedValue({
      credentials: null,
      view: { status: 'NOT_CONFIGURED', usingEnvironment: false, host: null, port: null, user: null, from: null, hasPassword: false },
    });

    expect(await deliveries.sweep()).toBe(2);
    expect(ctx.deliveryQueue.jobs.every((j) => j.channel === 'PUSH')).toBe(true);

    resolve.mockRestore();
    ctx.deliveryQueue.reset();
    expect(await deliveries.sweep()).toBe(4);
    expect(ctx.deliveryQueue.jobs.filter((j) => j.channel === 'EMAIL')).toHaveLength(2);
  });

  it('completes the pending email once the mail server is configured, without losing it', async () => {
    const { students } = await scenario(1);
    await ctx.runOutbox();
    const email = await ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'EMAIL' } });
    const smtp = ctx.app.get(SmtpConfigService);
    const none = vi.spyOn(smtp, 'transport').mockResolvedValue(null);
    await deliveries.deliverEmail(email.id);
    none.mockRestore();
    expect(await ctx.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      status: 'PENDING',
      lastError: 'SMTP_NOT_CONFIGURED',
    });

    later();
    ctx.deliveryQueue.reset();
    await deliveries.sweep();
    await runQueued();

    expect((await ctx.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: email.id } })).status).toBe('SENT');
    expect(ctx.smtp.to(students[0].email)).toHaveLength(1);
  });

  it('keeps every notice in the app and completes every send when push and email recover (SC-004)', async () => {
    const { students } = await scenario(3);
    await ctx.runOutbox();
    // The students have a device each.
    for (const [i, student] of students.entries()) {
      const session = await ctx.prisma.session.create({
        data: { userId: student.id, refreshTokenHash: `hash-${i}`, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await ctx.prisma.pushToken.create({
        data: { userId: student.id, sessionId: session.id, token: `ExponentPushToken[device-${i}]`, platform: 'ANDROID' },
      });
    }
    ctx.push.failNext = 1000;
    ctx.smtp.failNext = { count: 1000, code: 'ECONNREFUSED' };

    await runQueued();

    expect(await ctx.prisma.notification.count()).toBe(3);
    expect(await pending()).toBe(6);
    expect(ctx.push.sent).toHaveLength(0);
    expect(ctx.smtp.sent).toHaveLength(0);

    ctx.push.failNext = 0;
    ctx.smtp.failNext = null;
    later();
    await deliveries.sweep();
    await runQueued();

    expect(await pending()).toBe(0);
    expect(await ctx.prisma.notificationDelivery.count({ where: { status: 'SENT' } })).toBe(6);
    expect(ctx.push.sent).toHaveLength(3);
    expect(ctx.smtp.sent).toHaveLength(3);
  });

  it('does not send twice when the sweep queues a delivery that was in fact already done', async () => {
    await scenario(1);
    await ctx.runOutbox();
    await runQueued();
    const sentBefore = ctx.smtp.sent.length;
    later();
    await deliveries.sweep();
    await runQueued();
    expect(ctx.smtp.sent).toHaveLength(sentBefore);
  });
});

describe('delivery queue', () => {
  const build = () => {
    const addBulk = vi.fn().mockResolvedValue([]);
    const config = { get: (key: string) => ({ NOTIFICATION_DELIVERY_ATTEMPTS: 8, NOTIFICATION_BACKOFF_SECONDS: 15 })[key] } as unknown as ConfigService<never, true>;
    return { addBulk, queue: new DeliveryQueue({ addBulk } as unknown as Queue, config as never) };
  };

  it('uses the delivery id as job id, so adding it twice never duplicates the send', async () => {
    const { addBulk, queue } = build();
    await queue.enqueue([{ id: 'delivery-1', channel: 'PUSH' }]);
    const [[jobs]] = addBulk.mock.calls;
    expect(jobs[0]).toMatchObject({ name: 'push', data: { deliveryId: 'delivery-1' }, opts: { jobId: 'delivery-1' } });
  });

  it('retries with exponential waits taken from the configuration', async () => {
    const { addBulk, queue } = build();
    await queue.enqueue([{ id: 'delivery-2', channel: 'EMAIL' }]);
    const [[jobs]] = addBulk.mock.calls;
    expect(jobs[0].name).toBe('email');
    expect(jobs[0].opts).toMatchObject({ attempts: 8, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: true, removeOnFail: true });
  });

  it('does nothing without deliveries', async () => {
    const { addBulk, queue } = build();
    await queue.enqueue([]);
    expect(addBulk).not.toHaveBeenCalled();
  });
});
