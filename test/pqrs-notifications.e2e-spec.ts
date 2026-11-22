import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliveriesService } from '../src/notifications/deliveries.service.js';
import { createPqrs } from './utils/factories.js';
import { adminCaller, studentCaller, teacherCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const SECRET = 'Texto privado de la respuesta del CAE';
const PHONE = 'ExponentPushToken[pqrs-phone]';

// Every action of the CAE on a PQRS reaches its author in the inbox, by push and by email (spec 017, story 4).
describe('PQRS notices', () => {
  let ctx: TestContext;
  let deliveries: DeliveriesService;

  beforeAll(async () => {
    ctx = await createTestApp();
    deliveries = ctx.app.get(DeliveriesService);
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  async function scenario(kind: 'student' | 'teacher' = 'student', locale: 'es' | 'en' = 'es') {
    const me = kind === 'student' ? await studentCaller(ctx, { locale }) : await teacherCaller(ctx);
    const cae = await adminCaller(ctx);
    const pqrs = await createPqrs(ctx.prisma, { authorId: me.user.id, subject: 'Beca de transporte' });
    return { me, cae, pqrs };
  }
  const noticesOf = (userId: string) => ctx.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, include: { deliveries: true } });

  it('notices the author of each action, with the push and email deliveries pending', async () => {
    const { me, cae, pqrs } = await scenario();
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await cae.post(`/pqrs/${pqrs.id}/responses`, { body: SECRET });
    await cae.post(`/pqrs/${pqrs.id}/resolve`);
    expect(await ctx.runOutbox()).toBe(3);

    const notices = await noticesOf(me.user.id);
    expect(notices.map((n) => n.type).sort()).toEqual(['PQRS_IN_REVIEW', 'PQRS_RESOLVED', 'PQRS_RESPONDED']);
    for (const notice of notices) {
      expect(notice).toMatchObject({ pqrsId: pqrs.id, moduleId: null, locale: 'es', readAt: null });
      expect(notice.body).toContain('"Beca de transporte"');
      expect(notice.deliveries.map((d) => `${d.channel}:${d.status}`).sort()).toEqual(['EMAIL:PENDING', 'PUSH:PENDING']);
    }
    const inbox = (await me.get('/notifications')).body;
    expect(inbox.meta.total).toBe(3);
    expect(inbox.data[0]).toMatchObject({ moduleId: null, pqrsId: pqrs.id });
  });

  it('writes the notice in the language of the author', async () => {
    const { me, cae, pqrs } = await scenario('student', 'en');
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await ctx.runOutbox();
    const [notice] = await noticesOf(me.user.id);
    expect(notice).toMatchObject({ locale: 'en', title: 'Your PQRS is in review' });
  });

  it('notices a teacher author as well as a student', async () => {
    const { me, cae, pqrs } = await scenario('teacher');
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await ctx.runOutbox();
    expect(await noticesOf(me.user.id)).toHaveLength(1);
  });

  it('never carries the text of a reply in the notice, the push or the email', async () => {
    const { me, cae, pqrs } = await scenario();
    await ctx.http().put('/api/v1/notifications/devices').set('Authorization', `Bearer ${me.token}`).send({ token: PHONE, platform: 'ANDROID' }).expect(204);
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await cae.post(`/pqrs/${pqrs.id}/responses`, { body: SECRET });
    await ctx.runOutbox();

    for (const notice of await noticesOf(me.user.id)) {
      expect(`${notice.title} ${notice.body}`).not.toContain(SECRET);
      for (const delivery of notice.deliveries) await (delivery.channel === 'PUSH' ? deliveries.deliverPush(delivery.id) : deliveries.deliverEmail(delivery.id));
    }
    const [push] = ctx.push.to(PHONE);
    expect(push.data).toEqual({ notificationId: expect.any(String), pqrsId: pqrs.id });
    expect(ctx.push.to(PHONE).map((m) => `${m.title} ${m.body}`).join(' ')).not.toContain(SECRET);
    const mails = ctx.smtp.to(me.user.email);
    expect(mails).toHaveLength(2);
    for (const mail of mails) expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toContain(SECRET);
    expect(mails.map((m) => m.subject).sort()[0]).toContain('PQRS');
  });

  it.each([
    ['deactivated', { status: 'INACTIVE' as const }],
    ['deleted', { deletedAt: new Date() }],
  ])('notices nobody when the account of the author is %s, and the event is still processed', async (_name, change) => {
    const { me, cae, pqrs } = await scenario();
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await ctx.prisma.user.update({ where: { id: me.user.id }, data: change });
    expect(await ctx.runOutbox()).toBe(1);
    expect(await ctx.prisma.notification.count()).toBe(0);
    expect(await ctx.prisma.outboxEvent.count({ where: { processedAt: null } })).toBe(0);
  });

  it('keeps the notice in the inbox when the author has no device and a channel fails', async () => {
    const { me, cae, pqrs } = await scenario();
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await ctx.runOutbox();
    const [notice] = await noticesOf(me.user.id);
    await deliveries.deliverPush(notice.deliveries.find((d) => d.channel === 'PUSH')!.id);
    expect((await ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId: notice.id, channel: 'PUSH' } })).status).toBe('SKIPPED');
    expect((await me.get('/notifications/unread-count')).body).toEqual({ unread: 1 });
    expect((await ctx.prisma.pqrs.findUniqueOrThrow({ where: { id: pqrs.id } })).status).toBe('IN_REVIEW');
  });

  it('does not notice twice when the same event is processed again', async () => {
    const { me, cae, pqrs } = await scenario();
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await ctx.runOutbox();
    await ctx.prisma.outboxEvent.updateMany({ data: { processedAt: null } });
    await ctx.runOutbox();
    expect(await noticesOf(me.user.id)).toHaveLength(1);
  });
});
