import argon2 from 'argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activePeriod, moduleWithSessions } from './utils/enrollment.js';
import { createAdminSession, createEnrollment, createPeriod, createStudent, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('student account management (spec 016)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    token = (await createAdminSession(ctx)).token;
  });
  afterAll(() => ctx.close());

  const get = (path: string) =>
    ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  describe('list and detail (US1)', () => {
    it('lists only verified, live students with enrolledCount of the active period', async () => {
      const period = await activePeriod(ctx);
      const student = await createStudent(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
      await createStudent(ctx.prisma, { verified: false });
      await createStudent(ctx.prisma, { deletedAt: new Date() });
      const { module: first } = await moduleWithSessions(ctx, period.id);
      const { module: second } = await moduleWithSessions(ctx, period.id);
      const { module: third } = await moduleWithSessions(ctx, period.id);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: first.id });
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: second.id });
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: third.id, status: 'CANCELLED' });
      const closed = await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2020-01-01', endsOn: '2020-06-30' });
      const { module: old } = await moduleWithSessions(ctx, closed.id);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: old.id });

      const res = await get('/students');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: student.id, firstName: 'Ana', lastName: 'Ruiz', email: student.email, program: null, status: 'ACTIVE', enrolledCount: 2 },
      ]);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
    });

    it('orders by last name, searches without accents, filters by status', async () => {
      await createStudent(ctx.prisma, { firstName: 'María', lastName: 'Zuluaga' });
      await createStudent(ctx.prisma, { firstName: 'José', lastName: 'Álvarez', status: 'INACTIVE' });
      const names = async (query: string) =>
        (await get(`/students${query}`)).body.data.map((s: { firstName: string }) => s.firstName);
      expect(await names('')).toEqual(['José', 'María']);
      expect(await names('?search=jose')).toEqual(['José']);
      expect(await names('?search=ALVAREZ')).toEqual(['José']);
      expect(await names('?search=maria')).toEqual(['María']);
      expect(await names('?status=INACTIVE')).toEqual(['José']);
    });

    it('finds the right accounts among 500', async () => {
      const passwordHash = await argon2.hash('Clave1234');
      const rows = Array.from({ length: 500 }, (_, i) => ({
        id: crypto.randomUUID(),
        email: `est${i}@uts.edu.co`,
        passwordHash,
        role: 'STUDENT' as const,
        emailVerifiedAt: new Date(),
      }));
      await ctx.prisma.user.createMany({ data: rows });
      await ctx.prisma.studentProfile.createMany({
        data: rows.map((row, i) => ({ userId: row.id, firstName: i === 7 ? 'Sebastián' : 'Est', lastName: `Apellido${String(i).padStart(3, '0')}` })),
      });
      const all = await get('/students?limit=100');
      expect(all.body.meta.total).toBe(500);
      expect(all.body.data).toHaveLength(100);
      const found = await get('/students?search=sebastian');
      expect(found.body.data.map((s: { email: string }) => s.email)).toEqual(['est7@uts.edu.co']);
    });

    it('returns the detail, and 404 for an unverified student', async () => {
      const student = await createStudent(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
      const res = await get(`/students/${student.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: student.id, email: student.email, enrolledCount: 0 });

      const unverified = await createStudent(ctx.prisma, { verified: false });
      const missing = await get(`/students/${unverified.id}`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('ACCOUNT_NOT_FOUND');
    });
  });

  describe('deactivate, reactivate and delete (US2, US3)', () => {
    const post = (path: string) => ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    const del = (path: string) => ctx.http().delete(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

    async function enrolledStudent(modules = 2, periodStatus: 'ACTIVE' | 'CLOSED' = 'ACTIVE') {
      const period =
        periodStatus === 'ACTIVE'
          ? await activePeriod(ctx)
          : await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2020-01-01', endsOn: '2020-06-30' });
      const student = await createStudent(ctx.prisma);
      const made = [];
      for (let i = 0; i < modules; i++) {
        const m = await moduleWithSessions(ctx, period.id, { capacity: 1, slot: { dayOfWeek: 1 + i, startMinute: 840, endMinute: 960 } });
        await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
        made.push(m);
      }
      return { student, modules: made, period };
    }
    const enrollments = (studentId: string) =>
      ctx.prisma.enrollment.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } });

    it('cancels the current enrollments of the active period in one go and frees the seats', async () => {
      const { student, modules } = await enrolledStudent();
      const res = await post(`/students/${student.id}/deactivate`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: student.id, status: 'INACTIVE', deleted: false, cancelledEnrollments: 2 });

      const rows = await enrollments(student.id);
      expect(rows.every((e) => e.status === 'CANCELLED' && e.cancelledAt && e.cancelledAt.getTime() === e.effectiveUntil?.getTime())).toBe(true);
      for (const { module } of modules) {
        expect(await ctx.prisma.enrollment.count({ where: { moduleId: module.id, status: 'ACTIVE' } })).toBe(0);
      }
      expect((await post(`/students/${student.id}/deactivate`)).body.cancelledEnrollments).toBe(0);
    });

    it('keeps the enrollments of a closed period untouched', async () => {
      const { student } = await enrolledStudent(1, 'CLOSED');
      const res = await post(`/students/${student.id}/deactivate`);
      expect(res.body.cancelledEnrollments).toBe(0);
      expect((await enrollments(student.id))[0].status).toBe('ACTIVE');
    });

    it('changes only the state between semesters (no active period)', async () => {
      const student = await createStudent(ctx.prisma);
      const res = await post(`/students/${student.id}/deactivate`);
      expect(res.body).toMatchObject({ status: 'INACTIVE', cancelledEnrollments: 0 });
    });

    it('does not restore enrollments on reactivation, and reactivating twice is the same', async () => {
      const { student } = await enrolledStudent(1);
      await post(`/students/${student.id}/deactivate`);
      expect((await post(`/students/${student.id}/reactivate`)).body).toEqual({ id: student.id, status: 'ACTIVE' });
      expect((await post(`/students/${student.id}/reactivate`)).body.status).toBe('ACTIVE');
      expect((await enrollments(student.id))[0].status).toBe('CANCELLED');
    });

    it('rolls everything back when one cancellation fails midway', async () => {
      const { student, modules } = await enrolledStudent();
      const failing = modules[1].module.id;
      await ctx.prisma.$executeRawUnsafe(`
        CREATE FUNCTION fail_cancel() RETURNS trigger AS $$ BEGIN
          IF NEW.module_id = '${failing}' AND NEW.status = 'CANCELLED' THEN RAISE EXCEPTION 'boom'; END IF;
          RETURN NEW; END $$ LANGUAGE plpgsql`);
      await ctx.prisma.$executeRawUnsafe('CREATE TRIGGER fail_cancel BEFORE UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION fail_cancel()');
      try {
        expect((await post(`/students/${student.id}/deactivate`)).status).toBe(500);
      } finally {
        await ctx.prisma.$executeRawUnsafe('DROP TRIGGER fail_cancel ON enrollments');
        await ctx.prisma.$executeRawUnsafe('DROP FUNCTION fail_cancel()');
      }
      expect((await enrollments(student.id)).map((e) => e.status)).toEqual(['ACTIVE', 'ACTIVE']);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: student.id } })).status).toBe('ACTIVE');
    });

    it('deletes: cancels like deactivating, disappears, and the email stays taken', async () => {
      const { student } = await enrolledStudent(2);
      const res = await del(`/students/${student.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ deleted: true, cancelledEnrollments: 2 });
      expect((await get('/students')).body.data).toEqual([]);
      expect((await get(`/students/${student.id}`)).body.code).toBe('ACCOUNT_NOT_FOUND');
      const login = await ctx.http().post('/api/v1/auth/login').send({ email: student.email, password: TEST_PASSWORD });
      expect(login.status).not.toBe(200);
      const register = await ctx.http().post('/api/v1/auth/register')
        .send({ email: student.email, password: TEST_PASSWORD, firstName: 'Ana', lastName: 'Ruiz' });
      expect(register.status).toBeGreaterThanOrEqual(400);
      expect(await ctx.prisma.enrollment.count({ where: { studentId: student.id } })).toBe(2);
    });
  });
});
