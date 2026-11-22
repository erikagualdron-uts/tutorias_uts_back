import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { causeOf, DeliveriesService } from '../src/notifications/deliveries.service.js';
import { loginStudent } from './utils/enrollment.js';
import { createEnrollment, createOutboxEvent, createPqrs, createUser, TEST_PASSWORD } from './utils/factories.js';
import { adminCaller, pqrsBody, studentCaller } from './utils/pqrs.js';
import { teacherApi } from './utils/teacher.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('logs never contain secrets', () => {
  let ctx: TestContext;
  let output = '';

  beforeAll(async () => {
    ctx = await createTestApp();
    // Everything the process writes to stdout or stderr is collected, including Nest's logger.
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation(
        (chunk: string | Uint8Array) => {
          output += String(chunk);
          return true;
        },
      );
    }
  });
  beforeEach(() => ctx.reset());
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx.close();
  });

  const post = (path: string, body: object, token?: string) => {
    const req = ctx.http().post(`/api/v1${path}`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };

  it('keeps passwords, temporary passwords, codes and tokens out of the logs', async () => {
    const secrets: string[] = [];
    const student = {
      email: 'ana@uts.edu.co',
      password: 'SecretaReg123',
      firstName: 'Ana',
      lastName: 'Pérez',
      locale: 'es',
    };

    await post('/auth/register', student);
    const verification = ctx.mailbox.lastTo(student.email)!.code;
    await post('/auth/verify-email', {
      email: student.email,
      code: verification,
    });
    const login = await post('/auth/login', {
      email: student.email,
      password: student.password,
    });
    await post('/auth/login', {
      email: student.email,
      password: 'ClaveErrada999',
    });
    const refreshed = await post('/auth/refresh', {
      refreshToken: login.body.refreshToken,
    });
    await post(
      '/auth/change-password',
      { currentPassword: student.password, newPassword: 'NuevaSecreta456' },
      refreshed.body.accessToken,
    );

    await post('/auth/forgot-password', { email: student.email });
    const reset = ctx.mailbox.lastTo(student.email)!.code;
    await post('/auth/reset-password', {
      email: student.email,
      code: reset,
      newPassword: 'RecuperadaSecreta789',
    });
    await post('/auth/register', { ...student, password: 'x' }); // validation failure with a password in the body

    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const adminLogin = await post('/auth/login', {
      email: admin.email,
      password: TEST_PASSWORD,
    });
    const teacher = await post(
      '/teachers',
      {
        email: 'profe@correo.uts.edu.co',
        firstName: 'Luis',
        lastName: 'Gómez',
      },
      adminLogin.body.accessToken,
    );

    secrets.push(
      student.password,
      'ClaveErrada999',
      'NuevaSecreta456',
      'RecuperadaSecreta789',
      verification,
      reset,
      login.body.accessToken,
      login.body.refreshToken,
      refreshed.body.accessToken,
      refreshed.body.refreshToken,
      adminLogin.body.accessToken,
      adminLogin.body.refreshToken,
      teacher.body.temporaryPassword,
    );
    expect(teacher.status).toBe(201);
    for (const secret of secrets) expect(secret).toBeTruthy();
    for (const secret of secrets)
      expect(output, `log leaked ${secret.slice(0, 4)}…`).not.toContain(secret);
  });

  // Spec 014: the consumer, the deliveries and the mail settings log ids, types and stable causes only.
  it('keeps the mail password, addresses, device tokens and the text of notices out of the logs', async () => {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id);
    const student = await loginStudent(ctx);
    await createEnrollment(ctx.prisma, { studentId: student.user.id, moduleId: m.module.id });
    const cae = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const caeLogin = await post('/auth/login', { email: cae.email, password: TEST_PASSWORD });
    const caeToken = caeLogin.body.accessToken as string;
    const device = 'ExponentPushToken[log-redaction-device]';
    const smtpPassword = 'clave-smtp-muy-secreta';

    await ctx
      .http()
      .put('/api/v1/notifications/devices')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ token: device, platform: 'ANDROID' });
    await ctx
      .http()
      .put('/api/v1/settings/smtp')
      .set('Authorization', `Bearer ${caeToken}`)
      .send({ host: 'smtp.uts.edu.co', port: 587, user: 'cae-usuario', password: smtpPassword, from: 'cae@uts.edu.co' })
      .expect(200);
    await post('/settings/smtp/test', {}, caeToken);
    ctx.smtp.failNext = { count: 1, code: 'EAUTH' };
    await post('/settings/smtp/test', {}, caeToken);

    await teacherApi(ctx, m.teacher).cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    const notice = await ctx.prisma.notification.findFirstOrThrow({ where: { userId: student.user.id } });
    const row = await ctx.prisma.smtpConfig.findFirstOrThrow();
    const deliveries = ctx.app.get(DeliveriesService);
    const push = await ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'PUSH', notificationId: notice.id } });
    const email = await ctx.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'EMAIL', notificationId: notice.id } });
    ctx.push.failNext = 1;
    await deliveries.deliverPush(push.id).catch((error: unknown) => deliveries.markFailed(push.id, causeOf(error)));
    ctx.smtp.failNext = { count: 1, code: 'EAUTH' };
    await deliveries.deliverEmail(email.id).catch((error: unknown) => deliveries.markFailed(email.id, causeOf(error)));
    // An event that cannot be resolved is reported too.
    await createOutboxEvent(ctx.prisma, {
      type: 'MODULE_ROOM_CHANGED',
      moduleId: m.module.id,
      payload: { fromRoomId: m.room.id, toRoomId: '00000000-0000-4000-8000-000000000000', enrolled: 1 },
    });
    await ctx.runOutbox();

    expect(output).toContain('Delivery failed');
    const secrets = [smtpPassword, row.passwordEncrypted, student.user.email, device, notice.title, notice.body, 'cae-usuario'];
    for (const secret of secrets) expect(output, `log leaked ${secret.slice(0, 6)}…`).not.toContain(secret);
  });
  // Spec 017: filing, answering and resolving a PQRS and noticing its author log ids and causes only.
  it('keeps the subject, the description and the text of a reply out of the logs', async () => {
    const me = await studentCaller(ctx);
    const cae = await adminCaller(ctx);
    const subject = 'Asunto-confidencial-pqrs';
    const description = 'Descripcion-confidencial-pqrs';
    const reply = 'Respuesta-confidencial-pqrs';
    const filed = await me.post('/pqrs', pqrsBody({ subject, description }));
    await me.post('/pqrs', pqrsBody({ subject: '', description }));
    const seeded = await createPqrs(ctx.prisma, { authorId: me.user.id, subject, description });
    for (const id of [filed.body.id as string, seeded.id]) {
      await cae.post(`/pqrs/${id}/review`);
      await cae.post(`/pqrs/${id}/responses`, { body: reply });
      await cae.post(`/pqrs/${id}/resolve`);
    }
    await cae.post(`/pqrs/${filed.body.id}/responses`, { body: reply });
    await ctx.runOutbox();
    for (const delivery of await ctx.prisma.notificationDelivery.findMany()) {
      await ctx.app.get(DeliveriesService)[delivery.channel === 'PUSH' ? 'deliverPush' : 'deliverEmail'](delivery.id);
    }

    for (const text of [description, reply]) expect(output, `log leaked ${text}`).not.toContain(text);
    expect(output.split(subject).length - 1, 'the subject only appears in the notice, never in a log line').toBe(0);
  });
});
