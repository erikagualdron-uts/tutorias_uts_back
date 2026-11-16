import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('login and roles (US2)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const login = (email: string, password = TEST_PASSWORD) =>
    ctx.http().post('/api/v1/auth/login').send({ email, password });

  it.each(['STUDENT', 'TEACHER', 'SUPERADMIN'] as const)(
    'logs in a %s and returns its role',
    async (role) => {
      const user = await createUser(ctx.prisma, { role });
      const res = await login(user.email.toUpperCase());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.user).toMatchObject({ email: user.email, role });
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();
    },
  );

  it('answers the same for an unknown email and a wrong password', async () => {
    const user = await createUser(ctx.prisma);
    const wrong = await login(user.email, 'Otra12345');
    const unknown = await login('nobody@uts.edu.co');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('blocks an unverified student', async () => {
    const user = await createUser(ctx.prisma, { verified: false });
    const res = await login(user.email);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('locks the login after 5 failures and reports the wait time', async () => {
    const user = await createUser(ctx.prisma);
    for (let i = 0; i < 5; i++) await login(user.email, 'Otra12345');
    const res = await login(user.email);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('returns the current user on /auth/me and rejects a missing token', async () => {
    const user = await createUser(ctx.prisma, { role: 'TEACHER' });
    const { body, status } = await login(user.email);
    expect(status, JSON.stringify(body)).toBe(200);
    const me = await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body).toMatchObject({ id: user.id, role: 'TEACHER' });

    const anonymous = await ctx.http().get('/api/v1/auth/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('TOKEN_INVALID');
  });

  it('rejects a route of another role with FORBIDDEN_ROLE', async () => {
    const student = await createUser(ctx.prisma);
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const asStudent = await login(student.email);
    const asAdmin = await login(admin.email);

    const denied = await ctx
      .http()
      .get('/api/v1/probe/admin')
      .set('Authorization', `Bearer ${asStudent.body.accessToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN_ROLE');

    const allowed = await ctx
      .http()
      .get('/api/v1/probe/admin')
      .set('Authorization', `Bearer ${asAdmin.body.accessToken}`);
    expect(allowed.status).toBe(200);
  });
});
