import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminSession, createStudent, createTeacher, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('student changes their own name (spec 033)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const login = async (email: string) =>
    (await ctx.http().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD })).body.accessToken as string;

  const patch = (token: string | null, body: object) => {
    const req = ctx.http().patch('/api/v1/students/me');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
  };

  const studentWithToken = async () => {
    const student = await createStudent(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
    return { student, token: await login(student.email) };
  };

  const changes = () => ctx.prisma.studentNameChange.findMany();
  const profileOf = (userId: string) => ctx.prisma.studentProfile.findUniqueOrThrow({ where: { userId } });

  it('changes the name, answers the account and records the previous and new values', async () => {
    const { student, token } = await studentWithToken();

    const res = await patch(token, { firstName: ' María José ', lastName: "O'Brien-Núñez" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: student.id, role: 'STUDENT', firstName: 'María José', lastName: "O'Brien-Núñez" });
    expect(await profileOf(student.id)).toMatchObject({ firstName: 'María José', lastName: "O'Brien-Núñez" });
    expect(await changes()).toEqual([
      expect.objectContaining({
        userId: student.id,
        previousFirstName: 'Ana',
        previousLastName: 'Ruiz',
        newFirstName: 'María José',
        newLastName: "O'Brien-Núñez",
      }),
    ]);
  });

  it('writes nothing when the trimmed name does not change', async () => {
    const { student, token } = await studentWithToken();
    const before = await profileOf(student.id);

    const res = await patch(token, { firstName: ' Ana', lastName: 'Ruiz ' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ firstName: 'Ana', lastName: 'Ruiz' });
    expect(await changes()).toHaveLength(0);
    expect((await profileOf(student.id)).updatedAt).toEqual(before.updatedAt);
  });

  it.each([
    ['empty first name', { firstName: '', lastName: 'Ruiz' }],
    ['blank first name', { firstName: '   ', lastName: 'Ruiz' }],
    ['empty last name', { firstName: 'Ana', lastName: '' }],
    ['blank last name', { firstName: 'Ana', lastName: ' ' }],
    ['101-character first name', { firstName: 'a'.repeat(101), lastName: 'Ruiz' }],
    ['101-character last name', { firstName: 'Ana', lastName: 'a'.repeat(101) }],
    ['missing fields', {}],
  ])('rejects %s with VALIDATION_FAILED and changes nothing', async (_label, body) => {
    const { student, token } = await studentWithToken();

    const res = await patch(token, body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(await profileOf(student.id)).toMatchObject({ firstName: 'Ana', lastName: 'Ruiz' });
    expect(await changes()).toHaveLength(0);
  });

  it('accepts names of exactly 100 characters', async () => {
    const { token } = await studentWithToken();

    const res = await patch(token, { firstName: 'a'.repeat(100), lastName: 'b'.repeat(100) });

    expect(res.status).toBe(200);
  });

  it('rejects a disabled account (ACCOUNT_DISABLED) and a deleted one (ACCOUNT_UNAVAILABLE) without changes', async () => {
    const { student, token } = await studentWithToken();

    await ctx.prisma.user.update({ where: { id: student.id }, data: { status: 'INACTIVE' } });
    const disabled = await patch(token, { firstName: 'Otra', lastName: 'Persona' });
    expect(disabled.status).toBe(401);
    expect(disabled.body.code).toBe('ACCOUNT_DISABLED');

    await ctx.prisma.user.update({ where: { id: student.id }, data: { status: 'ACTIVE', deletedAt: new Date() } });
    const deleted = await patch(token, { firstName: 'Otra', lastName: 'Persona' });
    expect(deleted.status).toBe(401);
    expect(deleted.body.code).toBe('ACCOUNT_UNAVAILABLE');

    expect(await profileOf(student.id)).toMatchObject({ firstName: 'Ana', lastName: 'Ruiz' });
    expect(await changes()).toHaveLength(0);
  });

  it('leaves neither the new name nor a record when saving the record fails (one transaction)', async () => {
    const { student, token } = await studentWithToken();
    await ctx.prisma.$executeRawUnsafe(
      'ALTER TABLE student_name_changes ADD CONSTRAINT spec033_force_failure CHECK (false)',
    );
    try {
      const res = await patch(token, { firstName: 'Nuevo', lastName: 'Nombre' });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await ctx.prisma.$executeRawUnsafe('ALTER TABLE student_name_changes DROP CONSTRAINT spec033_force_failure');
    }

    expect(await profileOf(student.id)).toMatchObject({ firstName: 'Ana', lastName: 'Ruiz' });
    expect(await changes()).toHaveLength(0);
  });

  describe('permissions (US2)', () => {
    it('answers 401 without a token', async () => {
      expect((await patch(null, { firstName: 'Ana', lastName: 'Ruiz' })).status).toBe(401);
    });

    it('answers 403 FORBIDDEN_ROLE to a teacher and to the CAE, with no changes', async () => {
      const teacher = await createTeacher(ctx.prisma);
      const teacherToken = await login(teacher.email);
      const { token: adminToken } = await createAdminSession(ctx);

      for (const token of [teacherToken, adminToken]) {
        const res = await patch(token, { firstName: 'Otra', lastName: 'Persona' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN_ROLE');
      }
      expect(await changes()).toHaveLength(0);
    });

    it('refuses an id in the body, so another account can never be targeted', async () => {
      const { student, token } = await studentWithToken();
      const other = await createStudent(ctx.prisma, { firstName: 'Luis', lastName: 'Mora' });

      const res = await patch(token, { firstName: 'Nuevo', lastName: 'Nombre', userId: other.id });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await profileOf(student.id)).toMatchObject({ firstName: 'Ana', lastName: 'Ruiz' });
      expect(await profileOf(other.id)).toMatchObject({ firstName: 'Luis', lastName: 'Mora' });
      expect(await changes()).toHaveLength(0);
    });
  });
});
