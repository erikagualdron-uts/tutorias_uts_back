import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const EMAIL = 'ana.perez@uts.edu.co';
const MINUTE = 60_000;

describe('student registration and email verification (US1)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const post = (path: string, body: object) =>
    ctx.http().post(`/api/v1/auth/${path}`).send(body);
  const register = (overrides: object = {}) =>
    post('register', {
      email: EMAIL,
      password: TEST_PASSWORD,
      firstName: 'Ana',
      lastName: 'Pérez',
      locale: 'es',
      ...overrides,
    });
  const verify = (code: string, email = EMAIL) =>
    post('verify-email', { email, code });
  const login = (password = TEST_PASSWORD) =>
    post('login', { email: EMAIL, password });
  const wrongCode = () =>
    ctx.mailbox.lastTo(EMAIL)!.code === '000000' ? '111111' : '000000';

  it('registers a student, emails a 6-digit code and verifies the account', async () => {
    const res = await register({ email: ' Ana.Perez@UTS.edu.co ' });
    expect(res.status).toBe(202);
    expect(res.body.resendAvailableAt).toBeTruthy();

    const mail = ctx.mailbox.lastTo(EMAIL)!;
    expect(mail).toMatchObject({ template: 'verification', locale: 'es' });
    expect(mail.code).toMatch(/^[0-9]{6}$/);

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: EMAIL },
      include: { studentProfile: true },
    });
    expect(user).toMatchObject({ role: 'STUDENT', emailVerifiedAt: null });
    expect(user.studentProfile).toMatchObject({
      firstName: 'Ana',
      lastName: 'Pérez',
    });
    expect(user.passwordHash).not.toContain(TEST_PASSWORD);

    expect((await verify(mail.code)).status).toBe(204);
    expect((await login()).status).toBe(200);
  });

  it.each([
    'ana@gmail.com',
    'ana@correo.uts.edu.co',
    'ana@uts.edu.co.example.com',
  ])('rejects the domain of %s', async (email) => {
    const res = await register({ email });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    expect(ctx.mailbox.sent).toHaveLength(0);
  });

  it('rejects weak passwords and malformed bodies', async () => {
    expect((await register({ password: 'short' })).body.code).toBe(
      'PASSWORD_TOO_WEAK',
    );
    const invalid = await register({ locale: 'fr' });
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { locale: expect.any(String) } },
    });
  });

  it('answers 409 for a verified account and for a soft-deleted one', async () => {
    await createUser(ctx.prisma, { email: EMAIL });
    expect((await register()).body.code).toBe('EMAIL_ALREADY_REGISTERED');

    await ctx.reset();
    await createUser(ctx.prisma, {
      email: EMAIL,
      verified: false,
      deletedAt: new Date(),
    });
    const res = await register();
    expect(res.status).toBe(409);
    expect(ctx.mailbox.sent).toHaveLength(0);
  });

  it('re-registering an unverified account only resends the code and keeps the original password', async () => {
    const first = await register();
    ctx.clock.advance(2 * MINUTE);
    const second = await register({ password: 'Otra98765', firstName: 'Otra' });
    expect(second.status).toBe(first.status);
    expect(Object.keys(second.body)).toEqual(Object.keys(first.body));
    expect(ctx.mailbox.sent).toHaveLength(2);

    expect((await verify(ctx.mailbox.lastTo(EMAIL)!.code)).status).toBe(204);
    expect((await login()).status).toBe(200);
    expect((await login('Otra98765')).status).toBe(401);
    const profile = await ctx.prisma.studentProfile.findFirstOrThrow();
    expect(profile.firstName).toBe('Ana');
  });

  it('rejects a wrong code, then burns the code after 5 attempts', async () => {
    await register();
    const code = ctx.mailbox.lastTo(EMAIL)!.code;
    const bad = wrongCode();
    for (let i = 0; i < 5; i++)
      expect((await verify(bad)).body.code).toBe('CODE_INVALID');
    expect((await verify(code)).body.code).toBe('CODE_ATTEMPTS_EXCEEDED');
  });

  it('rejects an expired code and a code that was already used', async () => {
    await register();
    const code = ctx.mailbox.lastTo(EMAIL)!.code;
    ctx.clock.advance(25 * 60 * MINUTE);
    expect((await verify(code)).body.code).toBe('CODE_EXPIRED');

    await ctx.reset();
    await register();
    const fresh = ctx.mailbox.lastTo(EMAIL)!.code;
    expect((await verify(fresh)).status).toBe(204);
    expect((await verify(fresh)).body.code).toBe('CODE_INVALID');
  });

  it('a newer code invalidates the previous one', async () => {
    await register();
    const old = ctx.mailbox.lastTo(EMAIL)!.code;
    ctx.clock.advance(2 * MINUTE);
    await post('resend-verification', { email: EMAIL });
    const latest = ctx.mailbox.lastTo(EMAIL)!.code;
    expect(latest).not.toBe(old);
    expect((await verify(old)).body.code).toBe('CODE_INVALID');
    expect((await verify(latest)).status).toBe(204);
  });

  it('enforces the resend cooldown and the hourly limit', async () => {
    await register();
    await post('resend-verification', { email: EMAIL });
    expect(ctx.mailbox.sent).toHaveLength(1);

    for (let i = 0; i < 4; i++) {
      ctx.clock.advance(61_000);
      await post('resend-verification', { email: EMAIL });
    }
    expect(ctx.mailbox.sent).toHaveLength(5);

    ctx.clock.advance(61_000);
    await post('resend-verification', { email: EMAIL });
    expect(ctx.mailbox.sent).toHaveLength(5);
  });

  it('answers the resend the same way whether the account exists or not', async () => {
    await register();
    ctx.clock.advance(2 * MINUTE);
    const known = await post('resend-verification', { email: EMAIL });
    const unknown = await post('resend-verification', {
      email: 'nadie@uts.edu.co',
    });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(Object.keys(unknown.body)).toEqual(Object.keys(known.body));
  });

  it('keeps an unverified student out until the code is entered', async () => {
    await register();
    const res = await login();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });
});
