import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadContract, specPath } from './utils/contract.js';
import { loginStudent } from './utils/enrollment.js';
import { createOutboxEvent } from './utils/factories.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('014-notifications/contracts/notifications-api.yaml'));

// Real answers against specs/014-notifications/contracts/notifications-api.yaml.
describe.skipIf(!contract.available)('responses match notifications-api.yaml', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const check = (method: string, path: string, res: { status: number; body: unknown }, schema?: string) => {
    contract.assertDocumented(method, path, res.status);
    if (schema) contract.assertMatchesSchema(schema, res.body);
    return res;
  };

  it('inbox: list, counter, read one and read all', async () => {
    // `start` resets the data, so the student signs in after it.
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id);
    const student = await loginStudent(ctx);
    check('get', '/notifications', await student.get('/notifications'), 'NotificationPage');

    const event = await createOutboxEvent(ctx.prisma, {
      type: 'SESSION_RESCHEDULED',
      moduleId: m.module.id,
      payload: { scope: 'SESSION', sessions: [] },
    });
    const notice = await ctx.prisma.notification.create({
      data: {
        userId: student.user.id,
        eventId: event.id,
        type: 'SESSION_RESCHEDULED',
        moduleId: m.module.id,
        locale: 'es',
        title: 'Título',
        body: 'Cuerpo',
      },
    });
    const post = (path: string) => ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${student.token}`);

    const page = check('get', '/notifications', await student.get('/notifications'), 'NotificationPage');
    expect((page.body as { data: unknown[] }).data).toHaveLength(1);
    check('get', '/notifications/unread-count', await student.get('/notifications/unread-count'));
    expect((await student.get('/notifications/unread-count')).body).toEqual({ unread: 1 });
    check('post', '/notifications/{id}/read', await post(`/notifications/${notice.id}/read`), 'Notification');
    check('post', '/notifications/read-all', await post('/notifications/read-all'));
  });

  it('inbox errors: no session, not found and invalid page', async () => {
    check('get', '/notifications', await ctx.http().get('/api/v1/notifications'), 'Error');
    const student = await loginStudent(ctx);
    const missing = await ctx
      .http()
      .post('/api/v1/notifications/00000000-0000-4000-8000-000000000000/read')
      .set('Authorization', `Bearer ${student.token}`);
    check('post', '/notifications/{id}/read', missing, 'Error');
    expect(missing.status).toBe(404);
    const bad = await student.get('/notifications?page=0');
    expect(bad.status).toBe(400);
  });

  it('devices: register, invalid body, discard and no session', async () => {
    const student = await loginStudent(ctx);
    const auth = { Authorization: `Bearer ${student.token}` };
    const token = 'ExponentPushToken[contract-test]';
    const put = (body: object) => ctx.http().put('/api/v1/notifications/devices').set(auth).send(body);

    check('put', '/notifications/devices', await put({ token, platform: 'IOS' }));
    const invalid = check('put', '/notifications/devices', await put({ token: 'nope', platform: 'IOS' }), 'Error');
    expect(invalid.status).toBe(400);
    const gone = await ctx.http().delete(`/api/v1/notifications/devices/${encodeURIComponent(token)}`).set(auth);
    check('delete', '/notifications/devices/{token}', gone);
    check('put', '/notifications/devices', await ctx.http().put('/api/v1/notifications/devices').send({ token, platform: 'IOS' }), 'Error');
  });

  it('mail settings: read, save, invalid body, test and the rejections', async () => {
    const { createUser, TEST_PASSWORD } = await import('./utils/factories.js');
    const user = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };
    const valid = { host: 'smtp.uts.edu.co', port: 587, user: 'cae', password: 'clave', from: 'cae@uts.edu.co' };

    check('put', '/settings/smtp', await ctx.http().put('/api/v1/settings/smtp').set(auth).send(valid), 'SmtpSettings');
    check('get', '/settings/smtp', await ctx.http().get('/api/v1/settings/smtp').set(auth), 'SmtpSettings');
    check('put', '/settings/smtp', await ctx.http().put('/api/v1/settings/smtp').set(auth).send({ ...valid, port: 0 }), 'Error');
    check('post', '/settings/smtp/test', await ctx.http().post('/api/v1/settings/smtp/test').set(auth), 'SmtpTestResult');
    ctx.smtp.failNext = { count: 1, code: 'EAUTH' };
    const failed = check('post', '/settings/smtp/test', await ctx.http().post('/api/v1/settings/smtp/test').set(auth), 'SmtpTestResult');
    expect(failed.body).toEqual({ ok: false, cause: 'AUTH_FAILED' });
    check('get', '/settings/smtp', await ctx.http().get('/api/v1/settings/smtp'), 'Error');
    await ctx.prisma.smtpConfig.deleteMany();
    check('put', '/settings/smtp', await ctx.http().put('/api/v1/settings/smtp').set(auth).send({ ...valid, password: '' }), 'Error');
  });
});
