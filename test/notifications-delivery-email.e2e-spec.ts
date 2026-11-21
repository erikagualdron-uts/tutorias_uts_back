import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptAesGcm } from '../src/common/crypto.util.js';
import { causeOf, DeliveriesService, EmailSendError } from '../src/notifications/deliveries.service.js';
import { SmtpConfigService } from '../src/mail/smtp-config.service.js';
import { createEnrollment, createStudent } from './utils/factories.js';
import { teacherApi } from './utils/teacher.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// The email channel of a notice (FR-018 to FR-020 and FR-022): the language of the student, Bogota
// time, retries, no loss without configuration, and a failure that never reaches the other channels.
describe('notifications: email delivery', () => {
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

  async function scenario(emails: { email?: string; locale?: 'es' | 'en' }[] = [{}]) {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id, { name: 'Cálculo I' });
    const students = [];
    for (const overrides of emails) {
      const student = await createStudent(ctx.prisma, overrides);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      students.push(student);
    }
    const cancel = async () => {
      await teacherApi(ctx, m.teacher).cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
      await ctx.runOutbox();
    };
    return { m, students, cancel };
  }
  const emailOf = (userId: string) =>
    ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'EMAIL', notification: { userId } }, include: { notification: true } });
  const refreshed = (id: string) => ctx.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  it('sends the title and text of the notice to the institutional email (scenario 1)', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    const delivery = await emailOf(students[0].id);

    await deliveries.deliverEmail(delivery.id);

    const [mail] = ctx.smtp.to(students[0].email);
    expect(mail.subject).toBe(`${delivery.notification.title} - UTS Tutorías`);
    expect(mail.text).toContain(delivery.notification.body);
    expect(mail.text).toContain('Cálculo I');
    expect(mail.text).toMatch(/martes.*8 de enero.*2:00\s*p\.\s*m\./i);
    expect(mail.text).toContain('Institución Universitaria Tecnológica de Santander – UTS');
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
  });

  it('writes the email in English for an English student', async () => {
    const { students, cancel } = await scenario([{ locale: 'en' }]);
    await cancel();
    await deliveries.deliverEmail((await emailOf(students[0].id)).id);
    const [mail] = ctx.smtp.to(students[0].email);
    expect(mail.subject).toBe('Your session was cancelled - UTS Tutorías');
    expect(mail.text).toMatch(/^Hello,/);
    expect(mail.text).toMatch(/Tuesday, January 8 at 2:00\s*PM/);
  });

  it('retries a temporary failure with a stable cause and sends once when the server is back (scenario 2)', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    const delivery = await emailOf(students[0].id);
    ctx.smtp.failNext = { count: 2, code: 'ETIMEDOUT' };

    const first = await deliveries.deliverEmail(delivery.id).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(EmailSendError);
    expect(causeOf(first)).toBe('SMTP_TIMEOUT');
    await expect(deliveries.deliverEmail(delivery.id)).rejects.toBeInstanceOf(EmailSendError);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'PENDING', attempts: 2 });

    await deliveries.deliverEmail(delivery.id);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SENT', attempts: 3 });
    expect(ctx.smtp.to(students[0].email)).toHaveLength(1);
  });

  it.each([
    ['EAUTH', 'SMTP_AUTH_FAILED'],
    ['ECONNREFUSED', 'SMTP_CONNECTION_FAILED'],
    ['ETIMEDOUT', 'SMTP_TIMEOUT'],
    ['EENVELOPE', 'SMTP_SENDER_REJECTED'],
    ['SOMETHING_ELSE', 'SMTP_UNKNOWN'],
  ])('maps the SMTP error %s to the stable cause %s', async (code, cause) => {
    const { students, cancel } = await scenario();
    await cancel();
    ctx.smtp.failNext = { count: 1, code };
    const error = await deliveries.deliverEmail((await emailOf(students[0].id)).id).catch((e: unknown) => e);
    expect(causeOf(error)).toBe(cause);
  });

  it('fails the delivery for good when the retries run out, without touching the other recipients (scenario 3)', async () => {
    const { students, cancel } = await scenario([{}, {}]);
    await cancel();
    const [first, second] = [await emailOf(students[0].id), await emailOf(students[1].id)];
    ctx.smtp.failNext = { count: 1, code: 'EAUTH' };

    const error = await deliveries.deliverEmail(first.id).catch((e: unknown) => e);
    await deliveries.markFailed(first.id, causeOf(error));
    await deliveries.deliverEmail(second.id);

    expect(await refreshed(first.id)).toMatchObject({ status: 'FAILED', lastError: 'SMTP_AUTH_FAILED' });
    expect((await refreshed(second.id)).status).toBe('SENT');
    expect(ctx.smtp.to(students[1].email)).toHaveLength(1);
  });

  it('never stores free text or an address as the cause of a failure', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    ctx.smtp.failNext = { count: 1, code: 'EAUTH' };
    const delivery = await emailOf(students[0].id);
    const error = await deliveries.deliverEmail(delivery.id).catch((e: unknown) => e);
    await deliveries.markFailed(delivery.id, causeOf(error));
    const { lastError } = await refreshed(delivery.id);
    expect(lastError).toMatch(/^[A-Z_]+$/);
    expect(lastError).not.toContain(students[0].email);
  });

  it('skips an email of a domain that is not the student domain, without stopping the other channels', async () => {
    const { students, cancel } = await scenario([{ email: 'estudiante@gmail.com' }]);
    await cancel();
    const delivery = await emailOf(students[0].id);
    await deliveries.deliverEmail(delivery.id);
    expect(ctx.smtp.sent).toHaveLength(0);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SKIPPED', lastError: 'EMAIL_DOMAIN_NOT_ALLOWED' });
    const push = await ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'PUSH', notification: { userId: students[0].id } } });
    expect(push.status).toBe('PENDING');
    expect(await ctx.prisma.notification.count({ where: { userId: students[0].id } })).toBe(1);
  });

  it('leaves the email pending, spending no attempt, while the server is not configured (scenario 4)', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    const delivery = await emailOf(students[0].id);
    const smtp = ctx.app.get(SmtpConfigService);
    const none = vi.spyOn(smtp, 'transport').mockResolvedValue(null);

    await deliveries.deliverEmail(delivery.id);

    expect(ctx.smtp.sent).toHaveLength(0);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'PENDING', attempts: 0, lastError: 'SMTP_NOT_CONFIGURED' });
    none.mockRestore();

    await deliveries.deliverEmail(delivery.id);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'SENT', lastError: null });
    expect(ctx.smtp.to(students[0].email)).toHaveLength(1);
  });

  it('uses the settings the CAE saved, and a change applies to the next send without a restart (FR-030)', async () => {
    const { students, cancel } = await scenario([{}, {}]);
    await cancel();
    const [first, second] = [await emailOf(students[0].id), await emailOf(students[1].id)];
    await deliveries.deliverEmail(first.id);
    const key = ctx.app.get(ConfigService).get<string>('SMTP_ENCRYPTION_KEY')!;
    await ctx.prisma.smtpConfig.create({
      data: { host: 'smtp.uts.edu.co', port: 587, user: 'cae', passwordEncrypted: encryptAesGcm(key, 'secret'), from: 'cae@uts.edu.co' },
    });

    await deliveries.deliverEmail(second.id);

    expect(ctx.smtp.options.at(-1)).toMatchObject({ host: 'smtp.uts.edu.co', port: 587, auth: { user: 'cae', pass: 'secret' } });
    expect(ctx.smtp.sent.at(-1)?.from).toBe('cae@uts.edu.co');
    expect(ctx.smtp.options.at(0)?.host).not.toBe('smtp.uts.edu.co');
  });

  it('sends the pending email with the settings in force when it is sent, not when it was created', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    const delivery = await emailOf(students[0].id);
    const key = ctx.app.get(ConfigService).get<string>('SMTP_ENCRYPTION_KEY')!;
    await ctx.prisma.smtpConfig.create({
      data: { host: 'new.smtp.uts.edu.co', port: 465, user: 'u', passwordEncrypted: encryptAesGcm(key, 'p'), from: 'new@uts.edu.co' },
    });
    await deliveries.deliverEmail(delivery.id);
    expect(ctx.smtp.options.at(-1)).toMatchObject({ host: 'new.smtp.uts.edu.co', secure: true });
  });

  it('stays pending when the stored password can no longer be read, without errors for the student', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    const delivery = await emailOf(students[0].id);
    await ctx.prisma.smtpConfig.create({
      data: { host: 'smtp.uts.edu.co', port: 587, user: 'cae', passwordEncrypted: encryptAesGcm('f'.repeat(64), 'secret'), from: 'cae@uts.edu.co' },
    });
    await deliveries.deliverEmail(delivery.id);
    expect(ctx.smtp.sent).toHaveLength(0);
    expect(await refreshed(delivery.id)).toMatchObject({ status: 'PENDING', lastError: 'SMTP_NOT_CONFIGURED' });
    const inbox = await ctx.prisma.notification.count({ where: { userId: students[0].id } });
    expect(inbox).toBe(1);
  });

  it('never sends twice for the same delivery, even if the job runs again', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    const delivery = await emailOf(students[0].id);
    await deliveries.deliverEmail(delivery.id);
    await deliveries.deliverEmail(delivery.id);
    expect(ctx.smtp.to(students[0].email)).toHaveLength(1);
  });

  it('does not let a failing email delay the push of the same notice', async () => {
    const { students, cancel } = await scenario();
    await cancel();
    ctx.smtp.failNext = { count: 5, code: 'ECONNREFUSED' };
    const mail = await emailOf(students[0].id);
    await expect(deliveries.deliverEmail(mail.id)).rejects.toBeInstanceOf(EmailSendError);
    const push = await ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'PUSH', notification: { userId: students[0].id } } });
    await deliveries.deliverPush(push.id);
    expect((await refreshed(push.id)).status).toBe('SKIPPED');
    expect(await ctx.prisma.notification.count({ where: { userId: students[0].id } })).toBe(1);
  });
});
