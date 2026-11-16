import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('teacher creation and temporary password (US3)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const login = (email: string, password = TEST_PASSWORD) =>
    ctx.http().post('/api/v1/auth/login').send({ email, password });
  const tokenOf = async (email: string, password = TEST_PASSWORD) =>
    (await login(email, password)).body.accessToken as string;
  const createTeacher = (token: string, body: object = {}) =>
    ctx
      .http()
      .post('/api/v1/teachers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'profe@correo.uts.edu.co',
        firstName: 'Luis',
        lastName: 'Gómez',
        ...body,
      });

  const adminToken = async () => {
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    return tokenOf(admin.email);
  };

  it('lets the CAE create a teacher and shows the temporary password only in that response', async () => {
    const res = await createTeacher(await adminToken());
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d).{12}$/);
    expect(res.body.user).toMatchObject({
      email: 'profe@correo.uts.edu.co',
      role: 'TEACHER',
      mustChangePassword: true,
      firstName: 'Luis',
    });

    const stored = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'profe@correo.uts.edu.co' },
    });
    expect(stored.passwordHash).not.toContain(res.body.temporaryPassword);
    expect(stored.emailVerifiedAt).not.toBeNull();
    expect((await login(stored.email, res.body.temporaryPassword)).status).toBe(
      200,
    );
  });

  it('rejects a non-staff domain, duplicates and non-CAE callers', async () => {
    const token = await adminToken();
    const wrongDomain = await createTeacher(token, {
      email: 'profe@uts.edu.co',
    });
    expect(wrongDomain.status).toBe(422);
    expect(wrongDomain.body.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');

    expect((await createTeacher(token)).status).toBe(201);
    const duplicate = await createTeacher(token);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_ALREADY_REGISTERED');

    const teacher = await createUser(ctx.prisma, { role: 'TEACHER' });
    const student = await createUser(ctx.prisma);
    for (const user of [teacher, student]) {
      const denied = await createTeacher(await tokenOf(user.email), {
        email: 'otro@correo.uts.edu.co',
      });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('blocks everything except change-password and me until the temporary password is changed', async () => {
    const teacher = await createUser(ctx.prisma, {
      role: 'TEACHER',
      mustChangePassword: true,
    });
    const token = await tokenOf(teacher.email);
    const auth = { Authorization: `Bearer ${token}` };

    const blocked = await ctx.http().get('/api/v1/probe/any').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await ctx.http().get('/api/v1/auth/me').set(auth)).status).toBe(
      200,
    );

    const change = (body: object) =>
      ctx.http().post('/api/v1/auth/change-password').set(auth).send(body);
    expect(
      (
        await change({
          currentPassword: 'Incorrecta1',
          newPassword: 'Nueva12345',
        })
      ).body.code,
    ).toBe('INVALID_CREDENTIALS');
    expect(
      (await change({ currentPassword: TEST_PASSWORD, newPassword: 'corta1' }))
        .body.code,
    ).toBe('PASSWORD_TOO_WEAK');
    expect(
      (
        await change({
          currentPassword: TEST_PASSWORD,
          newPassword: TEST_PASSWORD,
        })
      ).body.code,
    ).toBe('PASSWORD_SAME_AS_CURRENT');

    expect(
      (
        await change({
          currentPassword: TEST_PASSWORD,
          newPassword: 'Nueva12345',
        })
      ).status,
    ).toBe(204);
    expect((await ctx.http().get('/api/v1/probe/any').set(auth)).status).toBe(
      200,
    );
    expect(
      (await login(teacher.email, 'Nueva12345')).body.user.mustChangePassword,
    ).toBe(false);
  });
});
