import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptAesGcm, encryptAesGcm } from '../src/common/crypto.util.js';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const VALID = { host: 'smtp.uts.edu.co', port: 587, user: 'cae', password: 'clave-secreta', from: 'cae@uts.edu.co' };

// The mail server settings of the CAE (spec 014, story 6): state, save, hidden password and test.
describe('smtp settings', () => {
  let ctx: TestContext;
  let key: string;
  let cae: { token: string; email: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    key = ctx.app.get(ConfigService).get<string>('SMTP_ENCRYPTION_KEY')!;
  });
  beforeEach(async () => {
    await ctx.reset();
    const user = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
    cae = { token: login.body.accessToken as string, email: user.email };
  });
  afterAll(() => ctx.close());

  const call = (method: 'get' | 'put' | 'post', url: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${cae.token}`);
    return body ? req.send(body) : req;
  };
  // The environment variables SMTP_* as the server would have them (empty host: none).
  const environment = (host: string) => {
    const config = ctx.app.get(ConfigService);
    const real = config.get.bind(config);
    return vi.spyOn(config, 'get').mockImplementation(((name: string) => (name === 'SMTP_HOST' ? host : real(name))) as never);
  };
  const rows = () => ctx.prisma.smtpConfig.findMany();

  it('reports that the server uses the environment variables when nothing is saved (scenario 1)', async () => {
    const spy = environment('mail.example.test');
    const res = await call('get', '/settings/smtp').expect(200);
    spy.mockRestore();
    expect(res.body).toMatchObject({ status: 'CONFIGURED', usingEnvironment: true, host: 'mail.example.test' });
  });

  it('reports "not configured" without a saved row or variables (scenario 1)', async () => {
    const spy = environment('');
    const res = await call('get', '/settings/smtp').expect(200);
    spy.mockRestore();
    expect(res.body).toEqual({ status: 'NOT_CONFIGURED', usingEnvironment: false, host: null, port: null, user: null, from: null, hasPassword: false });
  });

  it('saves the settings with the password encrypted and answers without it (scenario 2)', async () => {
    const res = await call('put', '/settings/smtp', VALID).expect(200);
    expect(res.body).toEqual({
      status: 'CONFIGURED',
      usingEnvironment: false,
      host: 'smtp.uts.edu.co',
      port: 587,
      user: 'cae',
      from: 'cae@uts.edu.co',
      hasPassword: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('clave-secreta');
    const [row] = await rows();
    expect(row.passwordEncrypted).not.toContain('clave-secreta');
    expect(decryptAesGcm(key, row.passwordEncrypted)).toBe('clave-secreta');
  });

  it('shows the saved data again with the password hidden, never complete (scenario 3)', async () => {
    await call('put', '/settings/smtp', VALID).expect(200);
    const res = await call('get', '/settings/smtp').expect(200);
    expect(res.body).toMatchObject({ host: 'smtp.uts.edu.co', port: 587, user: 'cae', from: 'cae@uts.edu.co', hasPassword: true });
    expect(Object.keys(res.body)).not.toContain('password');
    expect(JSON.stringify(res.body)).not.toContain('clave-secreta');
    expect(JSON.stringify(res.body)).not.toContain((await rows())[0].passwordEncrypted);
  });

  it.each([[undefined], ['']])('keeps the previous password when an edit leaves it as %j (scenario 4)', async (blank) => {
    await call('put', '/settings/smtp', VALID).expect(200);
    const body: Record<string, unknown> = { ...VALID, host: 'otro.uts.edu.co', port: 465 };
    if (blank === undefined) delete body.password;
    else body.password = blank;
    await call('put', '/settings/smtp', body).expect(200);
    const [row] = await rows();
    expect(row).toMatchObject({ host: 'otro.uts.edu.co', port: 465 });
    expect(decryptAesGcm(key, row.passwordEncrypted)).toBe('clave-secreta');
  });

  it('replaces the password when a new one is given', async () => {
    await call('put', '/settings/smtp', VALID).expect(200);
    await call('put', '/settings/smtp', { ...VALID, password: 'nueva-clave' }).expect(200);
    expect(decryptAesGcm(key, (await rows())[0].passwordEncrypted)).toBe('nueva-clave');
  });

  it('keeps a single row however many times it is saved', async () => {
    await call('put', '/settings/smtp', VALID).expect(200);
    await call('put', '/settings/smtp', { ...VALID, user: 'otro' }).expect(200);
    await call('put', '/settings/smtp', { ...VALID, user: 'otro-mas' }).expect(200);
    expect(await rows()).toHaveLength(1);
  });

  it('asks for the password when the settings are created without it', async () => {
    const { password: _omit, ...withoutPassword } = VALID;
    const res = await call('put', '/settings/smtp', withoutPassword).expect(422);
    expect(res.body.code).toBe('SMTP_PASSWORD_REQUIRED');
    expect(await rows()).toHaveLength(0);
  });

  it.each([
    ['a port of 0', { port: 0 }],
    ['a port above 65535', { port: 65536 }],
    ['a port that is not an integer', { port: 25.5 }],
    ['a port that is not a number', { port: 'smtp' }],
    ['a sender that is not an email', { from: 'no-es-un-correo' }],
    ['an empty host', { host: '' }],
    ['a host of only spaces', { host: '   ' }],
    ['an empty user', { user: '' }],
    ['a host longer than 255', { host: 'h'.repeat(256) }],
    ['a password longer than 255', { password: 'p'.repeat(256) }],
  ])('rejects %s and saves nothing (scenario 6)', async (_label, change) => {
    const res = await call('put', '/settings/smtp', { ...VALID, ...change }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(await rows()).toHaveLength(0);
  });

  it('rejects a body with missing fields', async () => {
    await call('put', '/settings/smtp', { host: 'smtp.uts.edu.co' }).expect(400);
    await call('put', '/settings/smtp', {}).expect(400);
  });

  it('asks to configure again when the saved password can no longer be read, and accepts a new one', async () => {
    await ctx.prisma.smtpConfig.create({
      data: { host: 'smtp.uts.edu.co', port: 587, user: 'cae', passwordEncrypted: encryptAesGcm('f'.repeat(64), 'vieja'), from: 'cae@uts.edu.co' },
    });
    expect((await call('get', '/settings/smtp').expect(200)).body.status).toBe('NEEDS_RECONFIGURATION');

    const { password: _omit, ...withoutPassword } = VALID;
    expect((await call('put', '/settings/smtp', withoutPassword).expect(422)).body.code).toBe('SMTP_PASSWORD_REQUIRED');

    const fixed = await call('put', '/settings/smtp', VALID).expect(200);
    expect(fixed.body.status).toBe('CONFIGURED');
    expect(decryptAesGcm(key, (await rows())[0].passwordEncrypted)).toBe('clave-secreta');
  });

  describe('test email', () => {
    it('sends it to the email of the CAE who asks, with the saved settings (scenario 5)', async () => {
      await call('put', '/settings/smtp', VALID).expect(200);
      const res = await call('post', '/settings/smtp/test').expect(200);
      expect(res.body).toEqual({ ok: true, cause: null });
      const [mail] = ctx.smtp.to(cae.email);
      expect(mail.subject).toBe('Prueba de correo - UTS Tutorías');
      expect(mail.from).toBe('cae@uts.edu.co');
      expect(ctx.smtp.options.at(-1)).toMatchObject({ host: 'smtp.uts.edu.co', auth: { user: 'cae', pass: 'clave-secreta' } });
    });

    it('applies a change at once, without restarting (FR-030)', async () => {
      await call('put', '/settings/smtp', VALID).expect(200);
      await call('post', '/settings/smtp/test').expect(200);
      await call('put', '/settings/smtp', { ...VALID, host: 'nuevo.uts.edu.co' }).expect(200);
      await call('post', '/settings/smtp/test').expect(200);
      expect(ctx.smtp.options.map((o) => o.host)).toEqual(['smtp.uts.edu.co', 'nuevo.uts.edu.co']);
    });

    it.each([
      ['EAUTH', 'AUTH_FAILED'],
      ['ECONNREFUSED', 'CONNECTION_FAILED'],
      ['ETIMEDOUT', 'TIMEOUT'],
      ['EENVELOPE', 'SENDER_REJECTED'],
      ['OTHER', 'UNKNOWN'],
    ])('answers 200 with the stable cause when the send fails with %s (scenario 5)', async (code, cause) => {
      await call('put', '/settings/smtp', VALID).expect(200);
      ctx.smtp.failNext = { count: 1, code };
      const res = await call('post', '/settings/smtp/test').expect(200);
      expect(res.body).toEqual({ ok: false, cause });
      expect(JSON.stringify(res.body)).not.toContain('smtp failure');
      expect(JSON.stringify(res.body)).not.toContain('clave-secreta');
    });

    it('answers 409 when there is nothing to send with', async () => {
      const spy = environment('');
      const res = await call('post', '/settings/smtp/test').expect(409);
      spy.mockRestore();
      expect(res.body.code).toBe('SMTP_NOT_CONFIGURED');
    });
  });
});
