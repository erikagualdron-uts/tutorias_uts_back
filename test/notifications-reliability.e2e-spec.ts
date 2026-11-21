import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliveriesService } from '../src/notifications/deliveries.service.js';
import { createEnrollment, createOutboxEvent, createStudent } from './utils/factories.js';
import { HOUR, seriesModule, start, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// No notice is lost or repeated (story 5): in order, once per change and person, atomically.
describe('notifications: reliability', () => {
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
    const m = await seriesModule(ctx, period.id, { name: 'Cálculo I' });
    const students = [];
    for (let i = 0; i < enrolled; i++) {
      const student = await createStudent(ctx.prisma);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      students.push(student);
    }
    // One cancellation event per session, as the teacher would leave them.
    const event = (index: number, createdAt: Date) =>
      createOutboxEvent(ctx.prisma, {
        type: 'SESSION_CANCELLED_TEACHER',
        moduleId: m.module.id,
        payload: { scope: 'SESSION', sessions: [{ sessionId: m.sessions[0][index].id, from: m.sessions[0][index].startsAt.toISOString() }] },
        createdAt,
      });
    return { m, students, event };
  }
  const counts = async () => ({
    notices: await ctx.prisma.notification.count(),
    deliveries: await ctx.prisma.notificationDelivery.count(),
    pendingEvents: await ctx.prisma.outboxEvent.count({ where: { processedAt: null } }),
  });

  it('processes the events that piled up while the service was off, all of them and in order (scenario 1)', async () => {
    const { event } = await scenario();
    const base = Date.now() - 60_000;
    // Inserted out of order on purpose: what counts is when they happened.
    const third = await event(2, new Date(base + 3000));
    const first = await event(0, new Date(base + 1000));
    const second = await event(1, new Date(base + 2000));

    expect(await ctx.runOutbox()).toBe(3);

    expect(await ctx.prisma.outboxEvent.count({ where: { processedAt: null } })).toBe(0);
    const queued = await ctx.prisma.notificationDelivery.findMany({
      where: { id: { in: ctx.deliveryQueue.jobs.map((j) => j.id) } },
      include: { notification: { select: { eventId: true } } },
    });
    const byId = new Map(queued.map((d) => [d.id, d.notification.eventId]));
    const order = [...new Set(ctx.deliveryQueue.jobs.map((j) => byId.get(j.id)))];
    expect(order).toEqual([first.id, second.id, third.id]);
  });

  it('does not notice again an event that was already processed (scenario 2)', async () => {
    const { event } = await scenario();
    await event(0, new Date());
    expect(await ctx.runOutbox()).toBe(1);
    const before = await counts();
    expect(await ctx.runOutbox()).toBe(0);
    expect(await counts()).toEqual(before);
    expect(before).toEqual({ notices: 2, deliveries: 4, pendingEvents: 0 });
  });

  it('gives a single notice per person even if the event is processed twice at once', async () => {
    const { event } = await scenario(5);
    await event(0, new Date());
    await event(1, new Date());
    await Promise.all([ctx.runOutbox(), ctx.runOutbox(), ctx.runOutbox()]);
    expect(await counts()).toEqual({ notices: 10, deliveries: 20, pendingEvents: 0 });
    const perPerson = await ctx.prisma.notification.groupBy({ by: ['eventId', 'userId'], _count: true });
    expect(perPerson.every((row) => row._count === 1)).toBe(true);
  });

  it('keeps the event pending, with no partial notices, when something fails halfway (scenario 1)', async () => {
    const { event } = await scenario(3);
    await event(0, new Date());
    // A trigger makes the creation of the deliveries fail after the notices were inserted.
    await ctx.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_delivery() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$ LANGUAGE plpgsql`);
    await ctx.prisma.$executeRawUnsafe('CREATE TRIGGER fail_delivery BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION fail_delivery()');
    try {
      expect(await ctx.runOutbox()).toBe(0);
      expect(await counts()).toEqual({ notices: 0, deliveries: 0, pendingEvents: 1 });
      expect(ctx.deliveryQueue.jobs).toHaveLength(0);
    } finally {
      await ctx.prisma.$executeRawUnsafe('DROP TRIGGER fail_delivery ON notification_deliveries');
      await ctx.prisma.$executeRawUnsafe('DROP FUNCTION fail_delivery()');
    }

    expect(await ctx.runOutbox()).toBe(1);
    expect(await counts()).toEqual({ notices: 3, deliveries: 6, pendingEvents: 0 });
  });

  it('goes on with the next events when one fails', async () => {
    const { m, event, students } = await scenario(1);
    await createOutboxEvent(ctx.prisma, {
      type: 'MODULE_ROOM_CHANGED',
      moduleId: m.module.id,
      payload: { fromRoomId: m.room.id, toRoomId: '00000000-0000-4000-8000-000000000000', enrolled: 1 },
      createdAt: new Date(Date.now() - 5000),
    });
    await event(0, new Date());
    await ctx.runOutbox();
    // The room event has no room: it is closed with no notices, and the cancellation still arrives.
    expect(await ctx.prisma.notification.count({ where: { userId: students[0].id, type: 'SESSION_CANCELLED_TEACHER' } })).toBe(1);
    expect(await ctx.prisma.outboxEvent.count({ where: { processedAt: null } })).toBe(0);
  });

  it('leaves the event processed and the deliveries pending when the queue is down', async () => {
    const { event } = await scenario();
    await event(0, new Date());
    ctx.deliveryQueue.failNext = 1;
    expect(await ctx.runOutbox()).toBe(1);
    expect(await counts()).toEqual({ notices: 2, deliveries: 4, pendingEvents: 0 });
    expect(ctx.deliveryQueue.jobs).toHaveLength(0);
    expect(await ctx.prisma.notificationDelivery.count({ where: { status: 'PENDING' } })).toBe(4);
  });

  it('delivers to the other 39 when the send to one fails, and retries only the failed one (scenario 3)', async () => {
    const { event, students } = await scenario(40);
    await event(0, new Date());
    await ctx.runOutbox();
    const emails = await ctx.prisma.notificationDelivery.findMany({
      where: { channel: 'EMAIL' },
      include: { notification: { select: { userId: true } } },
      orderBy: { id: 'asc' },
    });
    expect(emails).toHaveLength(40);
    ctx.smtp.failNext = { count: 1, code: 'ECONNRESET' };

    const failed: string[] = [];
    for (const delivery of emails) {
      await deliveries.deliverEmail(delivery.id).catch(() => failed.push(delivery.id));
    }

    expect(failed).toHaveLength(1);
    expect(ctx.smtp.sent).toHaveLength(39);
    expect(await ctx.prisma.notificationDelivery.count({ where: { channel: 'EMAIL', status: 'SENT' } })).toBe(39);

    await deliveries.deliverEmail(failed[0]);
    expect(ctx.smtp.sent).toHaveLength(40);
    expect(new Set(ctx.smtp.sent.map((m) => m.to)).size).toBe(40);
    expect(new Set(ctx.smtp.sent.map((m) => m.to))).toEqual(new Set(students.map((s) => s.email)));
  });

  // Creating the 100 accounts (a password hash each) is what takes time, not the processing.
  it('processes a change with 100 enrolled students in a few seconds (SC-006)', { timeout: 60_000 }, async () => {
    const { event } = await scenario(100);
    await event(0, new Date());
    const started = Date.now();
    await ctx.runOutbox();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await ctx.prisma.notification.count()).toBe(100);
  });

  it('notes the date a change happened: a student who enrolls later gets nothing from earlier events', async () => {
    const { m, event } = await scenario(1);
    await event(0, new Date());
    await ctx.runOutbox();
    const late = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, { studentId: late.id, moduleId: m.module.id });
    await ctx.runOutbox();
    expect(await ctx.prisma.notification.count({ where: { userId: late.id } })).toBe(0);
  });

  it('stamps the events it processes with the moment it did', async () => {
    const { event } = await scenario(1);
    await event(0, new Date());
    ctx.clock.freezeAt(new Date(week(0).getTime() - HOUR));
    await ctx.runOutbox();
    expect((await ctx.prisma.outboxEvent.findFirstOrThrow()).processedAt?.toISOString()).toBe(new Date(week(0).getTime() - HOUR).toISOString());
  });
});
