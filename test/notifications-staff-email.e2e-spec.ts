import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpConfigService } from '../src/mail/smtp-config.service.js';
import { DeliveriesService } from '../src/notifications/deliveries.service.js';
import { createPqrs, createTeacher } from './utils/factories.js';
import { adminCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const SECRET = 'Texto privado de la respuesta del CAE';

// The email of a notice goes to any institutional address, student or staff (spec 025).
describe('notifications: email to staff', () => {
  let ctx: TestContext;
  let deliveries: DeliveriesService;

  beforeAll(async () => {
    ctx = await createTestApp();
    deliveries = ctx.app.get(DeliveriesService);
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  // A teacher files a PQRS and the CAE reviews, answers and resolves it.
  async function teacherNotices(locale: 'es' | 'en' = 'es') {
    const user = await createTeacher(ctx.prisma, { locale });
    const me = { user };
    const cae = await adminCaller(ctx);
    const pqrs = await createPqrs(ctx.prisma, { authorId: user.id, subject: 'Aula sin proyector' });
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await cae.post(`/pqrs/${pqrs.id}/responses`, { body: SECRET });
    await cae.post(`/pqrs/${pqrs.id}/resolve`);
    await ctx.runOutbox();
    return { me, emails: await emailsOf(user.id) };
  }
  const emailsOf = (userId: string) =>
    ctx.prisma.notificationDelivery.findMany({ where: { channel: 'EMAIL', notification: { userId } }, include: { notification: true } });
  const refreshed = (id: string) => ctx.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  it('sends a teacher the email of every notice of the PQRS, without the text of the reply', async () => {
    const { me, emails } = await teacherNotices();
    expect(emails).toHaveLength(3);
    for (const email of emails) await deliveries.deliverEmail(email.id);

    for (const email of emails) expect(await refreshed(email.id)).toMatchObject({ status: 'SENT', lastError: null });
    const mails = ctx.smtp.to(me.user.email);
    expect(mails).toHaveLength(3);
    for (const mail of mails) expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toContain(SECRET);
  });

  it('writes the email of a teacher in English when the account is in English', async () => {
    const { me, emails } = await teacherNotices('en');
    await deliveries.deliverEmail(emails[0].id);
    expect(ctx.smtp.to(me.user.email)[0].subject).toMatch(/PQRS/);
    expect(emails[0].notification.locale).toBe('en');
  });

  it('keeps the email of a teacher pending while the server is not configured, and skips a deactivated account', async () => {
    const { me, emails } = await teacherNotices();
    const none = vi.spyOn(ctx.app.get(SmtpConfigService), 'transport').mockResolvedValue(null);
    await deliveries.deliverEmail(emails[0].id);
    none.mockRestore();
    expect(await refreshed(emails[0].id)).toMatchObject({ status: 'PENDING', attempts: 0, lastError: 'SMTP_NOT_CONFIGURED' });

    await ctx.prisma.user.update({ where: { id: me.user.id }, data: { status: 'INACTIVE' } });
    await deliveries.deliverEmail(emails[1].id);
    expect(await refreshed(emails[1].id)).toMatchObject({ status: 'SKIPPED', lastError: 'ACCOUNT_UNAVAILABLE' });
  });

  // The same rule for every account: the CAE has no notices yet, so its address is tried on a teacher notice.
  it.each([
    ['the CAE staff address', 'cae@correo.uts.edu.co', 'SENT'],
    ['a student address', 'ana@uts.edu.co', 'SENT'],
    ['an address with capitals and spaces', '  Docente@Correo.UTS.edu.co ', 'SENT'],
    ['a personal address', 'docente@gmail.com', 'SKIPPED'],
    ['a similar subdomain', 'docente@otra.correo.uts.edu.co', 'SKIPPED'],
    ['an appended text', 'docente@correo.uts.edu.co.example.com', 'SKIPPED'],
  ])('decides %s by its domain', async (_name, email, status) => {
    const { me, emails } = await teacherNotices();
    await ctx.prisma.user.update({ where: { id: me.user.id }, data: { email } });
    await deliveries.deliverEmail(emails[0].id);
    expect(await refreshed(emails[0].id)).toMatchObject(status === 'SENT' ? { status } : { status, lastError: 'EMAIL_DOMAIN_NOT_ALLOWED' });
    expect(ctx.smtp.sent).toHaveLength(status === 'SENT' ? 1 : 0);
    expect(await ctx.prisma.notification.count({ where: { userId: me.user.id } })).toBe(3);
  });

  it('applies a change of the staff domain to the next email, and never resends one already skipped', async () => {
    const { me, emails } = await teacherNotices();
    await ctx.prisma.user.update({ where: { id: me.user.id }, data: { email: 'docente@uts-staff.edu.co' } });
    await deliveries.deliverEmail(emails[0].id);
    expect(await refreshed(emails[0].id)).toMatchObject({ status: 'SKIPPED', lastError: 'EMAIL_DOMAIN_NOT_ALLOWED' });

    await ctx.prisma.setting.upsert({ where: { key: 'auth.staffEmailDomain' }, create: { key: 'auth.staffEmailDomain', value: 'uts-staff.edu.co' }, update: { value: 'uts-staff.edu.co' } });
    await deliveries.deliverEmail(emails[0].id);
    expect((await refreshed(emails[0].id)).status).toBe('SKIPPED');
    await deliveries.deliverEmail(emails[1].id);
    expect((await refreshed(emails[1].id)).status).toBe('SENT');
  });

  it('writes neither the address nor the text of the reply in the server logs', async () => {
    const log = vi.spyOn(process.stdout, 'write');
    const { me, emails } = await teacherNotices();
    for (const email of emails) await deliveries.deliverEmail(email.id);
    const output = log.mock.calls.map((call) => String(call[0])).join('');
    log.mockRestore();
    expect(output).not.toContain(me.user.email);
    expect(output).not.toContain(SECRET);
  });
});
