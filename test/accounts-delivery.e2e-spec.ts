import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliveriesService } from '../src/notifications/deliveries.service.js';
import { createEnrollment, createStudent } from './utils/factories.js';
import { teacherApi } from './utils/teacher.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// A notice created before the account was closed is not delivered afterwards (spec 016, FR-013).
describe('deliveries to a closed account', () => {
  let ctx: TestContext;
  let deliveries: DeliveriesService;

  beforeAll(async () => {
    ctx = await createTestApp();
    deliveries = ctx.app.get(DeliveriesService);
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  async function pendingNotice() {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id, { name: 'Cálculo I' });
    const student = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
    await teacherApi(ctx, m.teacher).cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    const delivery = (channel: 'EMAIL' | 'PUSH') =>
      ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel, notification: { userId: student.id } } });
    return { student, delivery };
  }
  const reload = (id: string) => ctx.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  it.each([
    ['deactivated', { status: 'INACTIVE' as const }],
    ['deleted', { deletedAt: new Date() }],
  ])('skips the email and the push of an account that was %s', async (_, change) => {
    const { student, delivery } = await pendingNotice();
    const [email, push] = [await delivery('EMAIL'), await delivery('PUSH')];
    await ctx.prisma.user.update({ where: { id: student.id }, data: change });

    await deliveries.deliverEmail(email.id);
    await deliveries.deliverPush(push.id);

    expect(await reload(email.id)).toMatchObject({ status: 'SKIPPED', lastError: 'ACCOUNT_UNAVAILABLE' });
    expect(await reload(push.id)).toMatchObject({ status: 'SKIPPED', lastError: 'ACCOUNT_UNAVAILABLE' });
    expect(ctx.smtp.to(student.email)).toHaveLength(0);
    expect(ctx.push.sent).toHaveLength(0);
  });

  it('delivers the email of an account reactivated before delivery', async () => {
    const { student, delivery } = await pendingNotice();
    const email = await delivery('EMAIL');
    await ctx.prisma.user.update({ where: { id: student.id }, data: { status: 'INACTIVE' } });
    await ctx.prisma.user.update({ where: { id: student.id }, data: { status: 'ACTIVE' } });

    await deliveries.deliverEmail(email.id);

    expect((await reload(email.id)).status).toBe('SENT');
    expect(ctx.smtp.to(student.email)).toHaveLength(1);
  });
});
