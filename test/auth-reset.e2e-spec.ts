import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const EMAIL = 'ana@uts.edu.co';
const NEW_PASSWORD = 'Nueva12345';

describe('password recovery (US4)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const post = (path: string, body: object) =>
    ctx.http().post(`/api/v1/auth/${path}`).send(body);
  const forgot = (email = EMAIL) => post('forgot-password', { email });
  const reset = (code: string, newPassword = NEW_PASSWORD, email = EMAIL) =>
    post('reset-password', { email, code, newPassword });
  const login = (password: string, email = EMAIL) =>
    post('login', { email, password });
  const requestCode = async () => {
    await forgot();
    return ctx.mailbox.lastTo(EMAIL)!.code;
  };

  it('resets the password with the emailed code and signs in with the new one', async () => {
    await createUser(ctx.prisma, { email: EMAIL });
    const code = await requestCode();
    expect(ctx.mailbox.lastTo(EMAIL)).toMatchObject({
      template: 'reset',
      locale: 'es',
    });

    expect((await reset(code)).status).toBe(204);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
    expect((await login(TEST_PASSWORD)).status).toBe(401);
  });

  it('answers the same whether the email exists or not and sends nothing for unknown ones', async () => {
    await createUser(ctx.prisma, { email: EMAIL });
    const known = await forgot();
    const unknown = await forgot('nadie@uts.edu.co');
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(Object.keys(unknown.body)).toEqual(Object.keys(known.body));
    expect(ctx.mailbox.sent).toHaveLength(1);
  });

  it('rejects an expired code, a used code and a code with exhausted attempts', async () => {
    await createUser(ctx.prisma, { email: EMAIL });
    const code = await requestCode();
    ctx.clock.advance(61 * 60_000);
    expect((await reset(code)).body.code).toBe('CODE_EXPIRED');

    await ctx.reset();
    await createUser(ctx.prisma, { email: EMAIL });
    const fresh = await requestCode();
    expect((await reset(fresh)).status).toBe(204);
    expect((await reset(fresh)).body.code).toBe('CODE_INVALID');

    await ctx.reset();
    await createUser(ctx.prisma, { email: EMAIL });
    const last = await requestCode();
    const wrong = last === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await reset(wrong);
    expect((await reset(last)).body.code).toBe('CODE_ATTEMPTS_EXCEEDED');
  });

  it('rejects a weak password without burning the code', async () => {
    await createUser(ctx.prisma, { email: EMAIL });
    const code = await requestCode();
    expect((await reset(code, 'corta1')).body.code).toBe('PASSWORD_TOO_WEAK');
    expect((await reset(code)).status).toBe(204);
  });

  it('closes every session of the user', async () => {
    await createUser(ctx.prisma, { email: EMAIL });
    const phone = (await login(TEST_PASSWORD)).body;
    const tablet = (await login(TEST_PASSWORD)).body;

    expect((await reset(await requestCode())).status).toBe(204);
    for (const { refreshToken } of [phone, tablet]) {
      expect((await post('refresh', { refreshToken })).body.code).toBe(
        'SESSION_REVOKED',
      );
    }
  });

  it('lifts the temporary-password block of a teacher', async () => {
    const teacher = await createUser(ctx.prisma, {
      role: 'TEACHER',
      mustChangePassword: true,
    });
    await post('forgot-password', { email: teacher.email });
    const { code } = ctx.mailbox.lastTo(teacher.email)!;

    expect((await reset(code, NEW_PASSWORD, teacher.email)).status).toBe(204);
    const res = await login(NEW_PASSWORD, teacher.email);
    expect(res.body.user.mustChangePassword).toBe(false);
  });

  it('verifies an unverified student who recovers the password', async () => {
    await createUser(ctx.prisma, { email: EMAIL, verified: false });
    expect((await login(TEST_PASSWORD)).body.code).toBe('EMAIL_NOT_VERIFIED');

    expect((await reset(await requestCode())).status).toBe(204);
    expect((await login(NEW_PASSWORD)).status).toBe(200);
  });

  it('gives no code to disabled or deleted accounts and does not reset them', async () => {
    await createUser(ctx.prisma, { email: EMAIL, status: 'INACTIVE' });
    await forgot();
    expect(ctx.mailbox.sent).toHaveLength(0);
    expect((await reset('123456')).body.code).toBe('CODE_INVALID');

    await ctx.reset();
    await createUser(ctx.prisma, { email: EMAIL, deletedAt: new Date() });
    await forgot();
    expect(ctx.mailbox.sent).toHaveLength(0);
    expect((await reset('123456')).body.code).toBe('CODE_INVALID');
  });
});
