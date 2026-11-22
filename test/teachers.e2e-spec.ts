import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTeacher as insertTeacher, createUser, TEST_PASSWORD } from './utils/factories.js';
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

describe('teachers list for the module selector (spec 010)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const res = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: TEST_PASSWORD });
    token = res.body.accessToken as string;
  });
  afterAll(() => ctx.close());

  const list = (query = '', bearer = token) =>
    ctx.http().get(`/api/v1/teachers${query}`).set('Authorization', `Bearer ${bearer}`);

  it('lists active and inactive teachers by last name then first name, without access data', async () => {
    await insertTeacher(ctx.prisma, { firstName: 'Zoila', lastName: 'Arias' });
    await insertTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Becerra' });
    await insertTeacher(ctx.prisma, { firstName: 'Luis', lastName: 'Arias', status: 'INACTIVE' });
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { firstName: string; lastName: string }) => `${t.lastName} ${t.firstName}`)).toEqual([
      'Arias Luis',
      'Arias Zoila',
      'Becerra Ana',
    ]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['email', 'firstName', 'id', 'lastName', 'modulesCount', 'status']);
  });

  it('leaves out deleted teachers, students and administrators', async () => {
    await insertTeacher(ctx.prisma, { firstName: 'Borrado', deletedAt: new Date() });
    await createUser(ctx.prisma, { role: 'STUDENT' });
    await insertTeacher(ctx.prisma, { firstName: 'Visible' });
    const res = await list();
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].firstName).toBe('Visible');
  });

  it('filters by status and searches names ignoring case', async () => {
    await insertTeacher(ctx.prisma, { firstName: 'María', lastName: 'Pérez' });
    await insertTeacher(ctx.prisma, { firstName: 'Mario', lastName: 'Rojas', status: 'INACTIVE' });
    expect((await list('?status=ACTIVE')).body.data.map((t: { firstName: string }) => t.firstName)).toEqual(['María']);
    expect((await list('?status=INACTIVE')).body.data.map((t: { firstName: string }) => t.firstName)).toEqual(['Mario']);
    expect((await list('?search=rojas')).body.data).toHaveLength(1);
    expect((await list('?search=MAR')).body.data).toHaveLength(2);
    expect((await list('?search=zzz')).body.data).toEqual([]);
  });

  it('paginates', async () => {
    for (const lastName of ['A', 'B', 'C']) await insertTeacher(ctx.prisma, { lastName });
    const res = await list('?limit=2&page=2');
    expect(res.body.data.map((t: { lastName: string }) => t.lastName)).toEqual(['C']);
    expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 3 });
  });

  it('rejects an unknown status', async () => {
    expect((await list('?status=MAYBE')).status).toBe(400);
  });

  it('is for the CAE only', async () => {
    const teacher = await createUser(ctx.prisma, { role: 'TEACHER' });
    const student = await createUser(ctx.prisma, { role: 'STUDENT' });
    for (const user of [teacher, student]) {
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD });
      const res = await list('', login.body.accessToken as string);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
    expect((await ctx.http().get('/api/v1/teachers')).status).toBe(401);
  });
});
