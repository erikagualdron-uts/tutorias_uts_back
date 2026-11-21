import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { causeOf, DeliveriesService, PushRejectedError } from '../src/notifications/deliveries.service.js';
import { PushUnavailableError } from '../src/notifications/push/push-gateway.js';
import { createEnrollment } from './utils/factories.js';
import { loginStudent, type Student } from './utils/enrollment.js';
import { teacherApi } from './utils/teacher.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const PHONE = 'ExponentPushToken[phone-phone-phone-phone]';
const TABLET = 'ExponentPushToken[tablet-tablet-tablet-t]';

// The push channel of a notice (FR-014 to FR-017): every live device, the same text, devices that are
// gone are dropped, and a repeated job never sends twice.
describe('notifications: push delivery', () => {
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

  // A student enrolled in a module whose first session the teacher cancels; the notice is created.
  async function scenario() {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id, { name: 'Cálculo I' });
    const student = await loginStudent(ctx);
    await createEnrollment(ctx.prisma, { studentId: student.user.id, moduleId: m.module.id });
    const device = (token: string, platform: 'ANDROID' | 'IOS' = 'ANDROID') =>
      ctx.http().put('/api/v1/notifications/devices').set('Authorization', `Bearer ${student.token}`).send({ token, platform }).expect(204);
    const cancel = async () => {
      await teacherApi(ctx, m.teacher).cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
      await ctx.runOutbox();
    };
    return { m, student, device, cancel };
  }
  const pushOf = (student: Student) =>
    ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'PUSH', notification: { userId: student.user.id } }, include: { notification: true } });
  const refreshed = (id: string) => ctx.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  it('sends the same title and text of the notice to the device (scenario 1)', async () => {
    const { m, student, device, cancel } = await scenario();
    await device(PHONE);
    await cancel();
    const delivery = await pushOf(student);

    await deliveries.deliverPush(delivery.id);

    const [message] = ctx.push.to(PHONE);
    expect(message.title).toBe(delivery.notification.title);
    expect(message.body).toBe(delivery.notification.body);
    expect(message.data).toEqual({ notificationId: delivery.notification.id, moduleId: m.module.id });
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
    expect((await refreshed(delivery.id)).sentAt).not.toBeNull();
  });

  it('sends to every device of the student (scenario 4)', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await device(TABLET, 'IOS');
    await cancel();
    await deliveries.deliverPush((await pushOf(student)).id);
    expect(ctx.push.to(PHONE)).toHaveLength(1);
    expect(ctx.push.to(TABLET)).toHaveLength(1);
  });

  it('skips the push without error when there is no device, and the notice stays in the app (scenario 3)', async () => {
    const { student, cancel } = await scenario();
    await cancel();
    const delivery = await pushOf(student);
    await deliveries.deliverPush(delivery.id);
    expect(ctx.push.sent).toHaveLength(0);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SKIPPED', lastError: 'PUSH_NO_DEVICES' });
    expect(await ctx.prisma.notification.count({ where: { userId: student.user.id } })).toBe(1);
  });

  it('does not use a device whose session was closed (scenario 5)', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await ctx.http().post('/api/v1/auth/logout').set('Authorization', `Bearer ${student.token}`).expect(204);
    await cancel();
    const delivery = await pushOf(student);
    await deliveries.deliverPush(delivery.id);
    expect(ctx.push.sent).toHaveLength(0);
    expect((await refreshed(delivery.id)).status).toBe('SKIPPED');
  });

  it('does not use a device of an expired session', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await ctx.prisma.session.updateMany({ where: { userId: student.user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await cancel();
    await deliveries.deliverPush((await pushOf(student)).id);
    expect(ctx.push.sent).toHaveLength(0);
  });

  it('drops a device the service reports as gone and does not retry it (scenario 6)', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    ctx.push.ticketErrors.set(PHONE, 'DEVICE_NOT_REGISTERED');
    await cancel();
    const delivery = await pushOf(student);

    await deliveries.deliverPush(delivery.id);

    expect((await ctx.prisma.pushToken.findUniqueOrThrow({ where: { token: PHONE } })).deletedAt).not.toBeNull();
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SKIPPED', lastError: 'PUSH_DEVICE_NOT_REGISTERED' });
    expect(ctx.push.sent).toHaveLength(1);
  });

  it('sends to the others and drops only the device that is gone', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await device(TABLET, 'IOS');
    ctx.push.ticketErrors.set(PHONE, 'DEVICE_NOT_REGISTERED');
    await cancel();
    const delivery = await pushOf(student);
    await deliveries.deliverPush(delivery.id);
    expect((await refreshed(delivery.id)).status).toBe('SENT');
    expect((await ctx.prisma.pushToken.findUniqueOrThrow({ where: { token: PHONE } })).deletedAt).not.toBeNull();
    expect((await ctx.prisma.pushToken.findUniqueOrThrow({ where: { token: TABLET } })).deletedAt).toBeNull();
  });

  it('retries when the service is down, counting each attempt, and sends once when it comes back', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await cancel();
    const delivery = await pushOf(student);
    ctx.push.failNext = 2;

    await expect(deliveries.deliverPush(delivery.id)).rejects.toBeInstanceOf(PushUnavailableError);
    await expect(deliveries.deliverPush(delivery.id)).rejects.toBeInstanceOf(PushUnavailableError);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'PENDING', attempts: 2 });

    await deliveries.deliverPush(delivery.id);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SENT', attempts: 3 });
    expect(ctx.push.to(PHONE)).toHaveLength(1);
  });

  it('retries when every device is refused for another reason', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    ctx.push.ticketErrors.set(PHONE, 'PUSH_REJECTED');
    await cancel();
    const delivery = await pushOf(student);
    await expect(deliveries.deliverPush(delivery.id)).rejects.toBeInstanceOf(PushRejectedError);
    expect((await refreshed(delivery.id)).status).toBe('PENDING');
    expect((await ctx.prisma.pushToken.findUniqueOrThrow({ where: { token: PHONE } })).deletedAt).toBeNull();
  });

  it('never sends twice for the same delivery, even if the job runs again', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await cancel();
    const delivery = await pushOf(student);
    await deliveries.deliverPush(delivery.id);
    await deliveries.deliverPush(delivery.id);
    expect(ctx.push.to(PHONE)).toHaveLength(1);
  });

  it('marks the delivery as failed when the retries run out, with a stable cause and no personal data', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await cancel();
    const delivery = await pushOf(student);
    await deliveries.markFailed(delivery.id, causeOf(new PushUnavailableError()));
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'FAILED', lastError: 'PUSH_UNAVAILABLE' });
    await deliveries.markFailed(delivery.id, 'OTHER');
    expect((await refreshed(delivery.id)).lastError).toBe('PUSH_UNAVAILABLE');
  });

  it('queues a check of the receipts with the ticket and the token, and drops what they report as gone', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await device(TABLET, 'IOS');
    await cancel();
    await deliveries.deliverPush((await pushOf(student)).id);

    const [entries] = ctx.deliveryQueue.receipts;
    expect(entries.map((e) => e.token).sort()).toEqual([PHONE, TABLET].sort());
    ctx.push.receipts.set(entries.find((e) => e.token === PHONE)!.ticketId, 'DEVICE_NOT_REGISTERED');

    await deliveries.checkReceipts(entries);

    expect((await ctx.prisma.pushToken.findUniqueOrThrow({ where: { token: PHONE } })).deletedAt).not.toBeNull();
    expect((await ctx.prisma.pushToken.findUniqueOrThrow({ where: { token: TABLET } })).deletedAt).toBeNull();
  });

  it('still sends the push when the receipts check cannot be queued', async () => {
    const { student, device, cancel } = await scenario();
    await device(PHONE);
    await cancel();
    ctx.deliveryQueue.enqueueReceipts = () => Promise.reject(new Error('queue down'));
    const delivery = await pushOf(student);
    await deliveries.deliverPush(delivery.id);
    expect((await refreshed(delivery.id)).status).toBe('SENT');
  });

  it('keeps the email and in-app notice when the student refused the permission (FR-017)', async () => {
    const { student, cancel } = await scenario();
    await cancel();
    const channels = await ctx.prisma.notificationDelivery.findMany({ where: { notification: { userId: student.user.id } } });
    expect(channels.map((d) => d.channel).sort()).toEqual(['EMAIL', 'PUSH']);
    await deliveries.deliverPush(channels.find((d) => d.channel === 'PUSH')!.id);
    expect((await ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'EMAIL' } })).status).toBe('PENDING');
    const inbox = await ctx.http().get('/api/v1/notifications').set('Authorization', `Bearer ${student.token}`).expect(200);
    expect(inbox.body.meta.total).toBe(1);
  });
});
