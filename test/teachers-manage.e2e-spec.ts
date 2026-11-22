import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activePeriod, moduleWithSessions } from './utils/enrollment.js';
import { createAdminSession, createModule, createPeriod, createStudent, createTeacher, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('teacher account management (spec 016)', () => {
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
    it('returns email and modulesCount, counting only live modules of the active period', async () => {
      const period = await activePeriod(ctx);
      const teacher = await createTeacher(ctx.prisma, { firstName: 'Luis', lastName: 'Gómez' });
      await moduleWithSessions(ctx, period.id, { teacherId: teacher.id });
      await moduleWithSessions(ctx, period.id, { teacherId: teacher.id, slot: { dayOfWeek: 3, startMinute: 840, endMinute: 960 } });
      await createModule(ctx.prisma, { periodId: period.id, teacherId: teacher.id, deletedAt: new Date(), schedules: [{ dayOfWeek: 4, startMinute: 840, endMinute: 960 }] });
      const closed = await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2020-01-01', endsOn: '2020-06-30' });
      await createModule(ctx.prisma, { periodId: closed.id, teacherId: teacher.id });

      const res = await get('/teachers');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { id: teacher.id, firstName: 'Luis', lastName: 'Gómez', email: teacher.email, status: 'ACTIVE', modulesCount: 2 },
      ]);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
    });

    it('excludes deleted teachers and orders by last name then first name', async () => {
      await createTeacher(ctx.prisma, { firstName: 'Zoe', lastName: 'Arias' });
      await createTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Arias' });
      await createTeacher(ctx.prisma, { firstName: 'Bob', lastName: 'Zapata' });
      await createTeacher(ctx.prisma, { firstName: 'Borrado', lastName: 'Arias', deletedAt: new Date() });
      const res = await get('/teachers');
      expect(res.body.data.map((t: { firstName: string }) => t.firstName)).toEqual(['Ana', 'Zoe', 'Bob']);
      expect(res.body.meta.total).toBe(3);
    });

    it('searches ignoring accents and case, and by partial email', async () => {
      await createTeacher(ctx.prisma, { firstName: 'José', lastName: 'Pérez', email: 'jperez@correo.uts.edu.co' });
      await createTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
      const names = async (search: string) =>
        (await get(`/teachers?search=${encodeURIComponent(search)}`)).body.data.map((t: { firstName: string }) => t.firstName);
      expect(await names('jose')).toEqual(['José']);
      expect(await names('JOSÉ')).toEqual(['José']);
      expect(await names('perez')).toEqual(['José']);
      expect(await names('jperez@')).toEqual(['José']);
      expect(await names('zzz')).toEqual([]);
    });

    it('filters by status and paginates with meta.total', async () => {
      await createTeacher(ctx.prisma, { lastName: 'A', status: 'INACTIVE' });
      for (const lastName of ['B', 'C', 'D']) await createTeacher(ctx.prisma, { lastName });
      const inactive = await get('/teachers?status=INACTIVE');
      expect(inactive.body.data).toHaveLength(1);
      expect(inactive.body.data[0].status).toBe('INACTIVE');

      const page2 = await get('/teachers?status=ACTIVE&page=2&limit=2');
      expect(page2.body.data.map((t: { lastName: string }) => t.lastName)).toEqual(['D']);
      expect(page2.body.meta).toEqual({ page: 2, limit: 2, total: 3 });
    });

    it('keeps the fields the module form selector needs', async () => {
      const teacher = await createTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
      const res = await get('/teachers?limit=100&status=ACTIVE');
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ id: teacher.id, firstName: 'Ana', lastName: 'Ruiz', status: 'ACTIVE' });
    });

    it('returns the detail with phone and modulesCount, and 404 for unknown or deleted', async () => {
      const period = await activePeriod(ctx);
      const teacher = await createTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
      await ctx.prisma.teacherProfile.update({ where: { userId: teacher.id }, data: { phone: '3001234567' } });
      await moduleWithSessions(ctx, period.id, { teacherId: teacher.id });

      const res = await get(`/teachers/${teacher.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: teacher.id, email: teacher.email, phone: '3001234567', modulesCount: 1 });

      const deleted = await createTeacher(ctx.prisma, { deletedAt: new Date() });
      expect((await get(`/teachers/${deleted.id}`)).body.code).toBe('ACCOUNT_NOT_FOUND');
      expect((await get(`/teachers/${crypto.randomUUID()}`)).status).toBe(404);
    });
  });

  describe('deactivate, reactivate and delete (US2, US3)', () => {
    const post = (path: string) => ctx.http().post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    const del = (path: string) => ctx.http().delete(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    const loginOf = (email: string) => ctx.http().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });

    async function teacherWithModules(count = 2) {
      const period = await activePeriod(ctx);
      const teacher = await createTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
      for (let i = 0; i < count; i++) {
        await moduleWithSessions(ctx, period.id, { teacherId: teacher.id, slot: { dayOfWeek: 1 + i, startMinute: 840, endMinute: 960 } });
      }
      return teacher;
    }

    it('deactivates: reports the modules, cuts the access at once and keeps the history', async () => {
      const teacher = await teacherWithModules();
      const session = (await loginOf(teacher.email)).body.accessToken as string;
      const sessionsBefore = await ctx.prisma.moduleSession.count({ where: { teacherId: teacher.id } });

      const res = await post(`/teachers/${teacher.id}/deactivate`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: teacher.id, status: 'INACTIVE', unavailableModules: 2 });

      const old = await ctx.http().get('/api/v1/teacher/modules').set('Authorization', `Bearer ${session}`);
      expect(old.status).toBe(401);
      expect(old.body.code).toBe('ACCOUNT_DISABLED');
      expect((await loginOf(teacher.email)).body.code).toBe('ACCOUNT_DISABLED');
      ctx.mailbox.clear();
      await ctx.http().post('/api/v1/auth/forgot-password').send({ email: teacher.email });
      expect(ctx.mailbox.lastTo(teacher.email)).toBeUndefined();

      const modules = await get('/modules');
      expect(modules.body.data).toHaveLength(2);
      expect(modules.body.data.every((m: { teacherUnavailable: boolean }) => m.teacherUnavailable)).toBe(true);
      expect(await ctx.prisma.moduleSession.count({ where: { teacherId: teacher.id } })).toBe(sessionsBefore);
      expect((await post(`/teachers/${teacher.id}/deactivate`)).body).toMatchObject({ status: 'INACTIVE', unavailableModules: 2 });
    });

    it('reactivates with the history intact and is idempotent', async () => {
      const teacher = await teacherWithModules(1);
      await post(`/teachers/${teacher.id}/deactivate`);
      const res = await post(`/teachers/${teacher.id}/reactivate`);
      expect(res.body).toEqual({ id: teacher.id, status: 'ACTIVE' });
      expect((await post(`/teachers/${teacher.id}/reactivate`)).body.status).toBe('ACTIVE');
      expect((await loginOf(teacher.email)).status).toBe(200);
      expect((await get('/modules')).body.data[0].teacherUnavailable).toBe(false);
    });

    it('deletes logically: gone from lists and actions, email stays taken, modules marked', async () => {
      const teacher = await teacherWithModules();
      const res = await del(`/teachers/${teacher.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ deleted: true, unavailableModules: 2 });
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.id } })).deletedAt).not.toBeNull();

      expect((await get('/teachers')).body.data).toEqual([]);
      for (const call of [get(`/teachers/${teacher.id}`), post(`/teachers/${teacher.id}/deactivate`), post(`/teachers/${teacher.id}/reactivate`), del(`/teachers/${teacher.id}`)]) {
        const gone = await call;
        expect(gone.status).toBe(404);
        expect(gone.body.code).toBe('ACCOUNT_NOT_FOUND');
      }
      expect((await loginOf(teacher.email)).status).not.toBe(200);
      const again = await ctx.http().post('/api/v1/teachers').set('Authorization', `Bearer ${token}`)
        .send({ email: teacher.email, firstName: 'Otra', lastName: 'Persona' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('EMAIL_ALREADY_REGISTERED');
      expect((await get('/modules')).body.data.every((m: { teacherUnavailable: boolean }) => m.teacherUnavailable)).toBe(true);
      expect((await get('/teachers?limit=100&status=ACTIVE')).body.data).toEqual([]);
    });

    it('deletes a teacher that was already deactivated', async () => {
      const teacher = await createTeacher(ctx.prisma);
      await post(`/teachers/${teacher.id}/deactivate`);
      expect((await del(`/teachers/${teacher.id}`)).body).toMatchObject({ deleted: true, unavailableModules: 0 });
    });
  });

  describe('edit and regenerate the password (US4, US5)', () => {
    const send = (method: 'patch' | 'post', path: string, body?: object) => {
      const req = ctx.http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
      return body ? req.send(body) : req;
    };
    const loginOf = (email: string, password: string) =>
      ctx.http().post('/api/v1/auth/login').send({ email, password });

    it('edits name and phone, shows them everywhere and clears the phone with null', async () => {
      const period = await activePeriod(ctx);
      const teacher = await createTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Ruiz' });
      const { module } = await moduleWithSessions(ctx, period.id, { teacherId: teacher.id });

      const res = await send('patch', `/teachers/${teacher.id}`, { firstName: '  María ', lastName: 'Pérez', phone: '3001112233' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: teacher.id, firstName: 'María', lastName: 'Pérez', phone: '3001112233', email: teacher.email });
      expect((await get('/teachers')).body.data[0]).toMatchObject({ firstName: 'María', lastName: 'Pérez' });
      expect((await get(`/modules/${module.id}`)).body.teacher).toMatchObject({ firstName: 'María', lastName: 'Pérez' });

      const cleared = await send('patch', `/teachers/${teacher.id}`, { firstName: 'María', lastName: 'Pérez', phone: null });
      expect(cleared.body.phone).toBeNull();
      const kept = await send('patch', `/teachers/${teacher.id}`, { firstName: 'María', lastName: 'Gómez' });
      expect(kept.body).toMatchObject({ lastName: 'Gómez', phone: null });
    });

    it('rejects empty, too long and unknown fields with 400 and the field in details.fields', async () => {
      const teacher = await createTeacher(ctx.prisma);
      const bad = async (body: object) => {
        const res = await send('patch', `/teachers/${teacher.id}`, body);
        expect(res.status).toBe(400);
        return res.body;
      };
      expect((await bad({ firstName: '   ', lastName: 'Ruiz' })).details.fields).toHaveProperty('firstName');
      expect((await bad({ firstName: 'Ana', lastName: '' })).details.fields).toHaveProperty('lastName');
      expect((await bad({ firstName: 'a'.repeat(81), lastName: 'Ruiz' })).details.fields).toHaveProperty('firstName');
      expect((await bad({ firstName: 'Ana', lastName: 'Ruiz', phone: '1'.repeat(31) })).details.fields).toHaveProperty('phone');
      await bad({ firstName: 'Ana', lastName: 'Ruiz', email: 'otro@correo.uts.edu.co' });
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.id } })).email).toBe(teacher.email);
    });

    it('answers 404 for a deleted or unknown teacher', async () => {
      const deleted = await createTeacher(ctx.prisma, { deletedAt: new Date() });
      for (const id of [deleted.id, crypto.randomUUID()]) {
        const res = await send('patch', `/teachers/${id}`, { firstName: 'Ana', lastName: 'Ruiz' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
      }
    });

    it('regenerates the temporary password: shown once, old one dead, sessions closed, never logged', async () => {
      const teacher = await createTeacher(ctx.prisma);
      const session = (await loginOf(teacher.email, TEST_PASSWORD)).body.accessToken as string;
      ctx.logs.reset();

      const res = await send('post', `/teachers/${teacher.id}/temporary-password`);
      expect(res.status).toBe(200);
      const { temporaryPassword } = res.body;
      expect(temporaryPassword).toMatch(/^(?=.*[A-Za-z])(?=.*\d).{12}$/);

      const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.id } });
      expect(stored.passwordHash).not.toContain(temporaryPassword);
      expect(stored.mustChangePassword).toBe(true);
      expect((await loginOf(teacher.email, TEST_PASSWORD)).status).not.toBe(200);
      const fresh = await loginOf(teacher.email, temporaryPassword);
      expect(fresh.status).toBe(200);
      expect(fresh.body.user.mustChangePassword).toBe(true);
      expect((await ctx.http().get('/api/v1/teacher/modules').set('Authorization', `Bearer ${session}`)).status).toBe(401);

      expect(JSON.stringify((await get(`/teachers/${teacher.id}`)).body)).not.toContain(temporaryPassword);
      expect(ctx.logs.lines.some((line) => line.includes(temporaryPassword))).toBe(false);
    });

    it('refuses a deactivated account (409), a deleted one (404) and a student (404)', async () => {
      const inactive = await createTeacher(ctx.prisma, { status: 'INACTIVE' });
      const refused = await send('post', `/teachers/${inactive.id}/temporary-password`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('ACCOUNT_NOT_ACTIVE');

      const deleted = await createTeacher(ctx.prisma, { deletedAt: new Date() });
      const student = await createStudent(ctx.prisma);
      for (const id of [deleted.id, student.id]) {
        const res = await send('post', `/teachers/${id}/temporary-password`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
      }
    });
  });
});
