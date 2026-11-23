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
import { ChatRetentionTask } from '../src/chat/chat-retention.task.js';
import { closeAllChatClients, connectChat, createChatMessage } from './utils/chat.js';
import { chatWorld, directWith, messageBody, moduleChatOf } from './utils/chat-world.js';
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
  // Spec 019: the dashboards only read; they log nothing about people, PQRS or messages.
  it('keeps PQRS subjects and module names out of the logs when the dashboards are read', async () => {
    const me = await studentCaller(ctx);
    const cae = await adminCaller(ctx);
    const subject = 'Asunto-confidencial-dashboard';
    await createPqrs(ctx.prisma, { authorId: me.user.id, subject });
    for (const caller of [me, cae]) {
      await caller.get(caller === me ? '/dashboard/student' : '/dashboard/admin/overview');
    }
    await cae.get('/dashboard/admin/changes');
    await cae.get('/dashboard/admin/rooms');
    await me.get('/dashboard/teacher'); // refused: still no text in the logs
    expect(output).not.toContain(subject);
    expect(output).not.toContain(me.user.email);
  });
  // Spec 021: the student calendar only reads; names of modules, teachers and rooms never reach the logs.
  it('keeps module names, teachers and the student out of the logs when the calendar is read', async () => {
    const p = await start(ctx); // moves the clock to 2030: sign in after it
    const me = await studentCaller(ctx);
    const name = 'Modulo-confidencial-calendario';
    const m = await seriesModule(ctx, p.id, { weeks: 1, name });
    await createEnrollment(ctx.prisma, { studentId: me.user.id, moduleId: m.module.id });
    const teacher = await ctx.prisma.teacherProfile.findFirstOrThrow({ where: { userId: m.teacher.user.id } });

    expect((await me.get('/student/calendar?from=2030-01-07&to=2030-01-13')).body.data).toHaveLength(1);
    await me.get('/student/calendar?from=hoy&to=2030-01-13'); // refused: still nothing in the logs
    for (const text of [name, teacher.lastName, me.user.email]) expect(output, `log leaked ${text}`).not.toContain(text);
  });
  // Spec 022: the "is typing" notice is ephemeral; neither it nor the conversation it names reaches the logs.
  it('writes nothing about a typing notice, its conversation or a retried message in the logs', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const direct = await directWith(student, teacher);
    const [mine, theirs] = [await connectChat(ctx, student.token), await connectChat(ctx, teacher.token)];
    try {
      await theirs.emitWithAck('conversation:open', { conversationId: direct.id });
      const before = output.length;
      await mine.emitWithAck('typing', { conversationId: direct.id });
      await theirs.waitFor('typing');
      await mine.emitWithAck('typing', { conversationId: 'not-a-uuid' });
      const secret = 'Pendiente-privado-chat-4';
      const body = messageBody({ body: secret });
      await student.post(`/chat/conversations/${direct.id}/messages`, body);
      await student.post(`/chat/conversations/${direct.id}/messages`, body); // the retry of a pending message
      await new Promise((resolve) => setTimeout(resolve, 200));
      const written = output.slice(before);
      for (const text of [secret, direct.id, 'typing']) expect(written, `log leaked ${text}`).not.toContain(text);
    } finally {
      closeAllChatClients();
    }
  });
  // Spec 018: sending, announcing, pushing (also when it fails) and the retention log counts, never text.
  it('keeps the text of chat messages and of their push out of the logs', async () => {
    const { student, teacher, module } = await chatWorld(ctx);
    const secrets = ['Mensaje-privado-chat-1', 'Anuncio-privado-chat-2', 'Mensaje-viejo-chat-3'];
    await ctx.http().put('/api/v1/notifications/devices').set('Authorization', `Bearer ${teacher.token}`).send({ token: 'ExponentPushToken[log-chat]', platform: 'ANDROID' });
    const direct = await directWith(student, teacher);
    const body = messageBody({ body: secrets[0] });
    await student.post(`/chat/conversations/${direct.id}/messages`, body);
    await student.post(`/chat/conversations/${direct.id}/messages`, body);
    ctx.push.failNext = 1;
    await student.post(`/chat/conversations/${direct.id}/messages`, messageBody({ body: secrets[0] }));
    await student.post(`/chat/conversations/${direct.id}/messages`, messageBody({ body: '' }));
    const group = await moduleChatOf(teacher, module.id);
    await teacher.post(`/chat/conversations/${group}/messages`, messageBody({ body: secrets[1], kind: 'ANNOUNCEMENT' }));
    await student.post(`/chat/conversations/${direct.id}/read`);
    await createChatMessage(ctx.prisma, { conversationId: direct.id, senderId: student.user.id, body: secrets[2], createdAt: new Date('2020-01-01T00:00:00Z') });
    await ctx.app.get(ChatRetentionTask).run();
    await new Promise((resolve) => setTimeout(resolve, 400));

    for (const text of secrets) expect(output, `log leaked ${text}`).not.toContain(text);
  });
});
