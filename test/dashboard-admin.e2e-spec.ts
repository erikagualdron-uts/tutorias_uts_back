import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnrollment, createModule, createPeriod, createPqrs, createRoom, createSession, createStudent } from './utils/factories.js';
import { adminCaller, type Caller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('CAE dashboard (spec 019)', () => {
  let ctx: TestContext;
  let admin: Caller;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    admin = await adminCaller(ctx);
  });
  afterAll(() => ctx.close());

  // A module of the ACTIVE period in a room of `capacity` seats with `enrolled` active students.
  async function moduleWith(periodId: string, capacity: number, enrolled: number, roomName?: string) {
    const room = await createRoom(ctx.prisma, { capacity, name: roomName });
    const module = await createModule(ctx.prisma, { periodId, roomId: room.id });
    for (let i = 0; i < enrolled; i++) {
      const student = await createStudent(ctx.prisma);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: module.id });
    }
    return { module, room };
  }

  describe('GET /dashboard/admin/overview', () => {
    it('is all zeros and null without data', async () => {
      const res = await admin.get('/dashboard/admin/overview');
      expect(res.status).toBe(200);
      expect(res.body.occupancy).toEqual({ enrolled: 0, capacity: 0, percent: 0 });
      expect(res.body.modules).toEqual({ active: 0, full: 0, lowEnrollment: 0 });
      expect(res.body.pqrs).toEqual({ filed: 0, inReview: 0, resolved: 0, avgResponseSeconds: null });
    });

    it('counts occupancy, full and low modules of the ACTIVE period only', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      await moduleWith(period.id, 10, 10); // full
      await moduleWith(period.id, 10, 2); // 20 % -> low
      const normal = await moduleWith(period.id, 10, 5);
      const inactive = await createStudent(ctx.prisma, { status: 'INACTIVE' });
      await createEnrollment(ctx.prisma, { studentId: inactive.id, moduleId: normal.module.id });
      const closed = await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2029-01-01', endsOn: '2029-06-30' });
      await moduleWith(closed.id, 10, 10); // other period: ignored

      const { body } = await admin.get('/dashboard/admin/overview');
      expect(body.occupancy).toEqual({ enrolled: 17, capacity: 30, percent: 56.7 });
      expect(body.modules).toEqual({ active: 3, full: 1, lowEnrollment: 1 });
      expect(body.lowEnrollmentPercent).toBe(30);
    });

    it('follows the configured low enrollment threshold', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      await moduleWith(period.id, 10, 4); // 40 %
      expect((await admin.get('/dashboard/admin/overview')).body.modules.lowEnrollment).toBe(0);
      await ctx.prisma.setting.upsert({
        where: { key: 'dashboard.lowEnrollmentPercent' },
        update: { value: 50 },
        create: { key: 'dashboard.lowEnrollmentPercent', value: 50 },
      });
      try {
        const { body } = await admin.get('/dashboard/admin/overview');
        expect(body.modules.lowEnrollment).toBe(1);
        expect(body.lowEnrollmentPercent).toBe(50);
      } finally {
        await ctx.prisma.setting.delete({ where: { key: 'dashboard.lowEnrollmentPercent' } });
      }
    });

    it('counts only active, not deleted students and teachers', async () => {
      await createStudent(ctx.prisma);
      await createStudent(ctx.prisma, { status: 'INACTIVE' });
      await createStudent(ctx.prisma, { deletedAt: new Date() });
      await createModule(ctx.prisma); // creates one active teacher
      const { body } = await admin.get('/dashboard/admin/overview');
      expect(body.accounts).toEqual({ students: 1, teachers: 1 });
    });

    it('counts PQRS by status without deleted ones and averages the response time of resolved ones', async () => {
      const author = await createStudent(ctx.prisma);
      await createPqrs(ctx.prisma, { authorId: author.id });
      await createPqrs(ctx.prisma, { authorId: author.id, status: 'IN_REVIEW' });
      await createPqrs(ctx.prisma, { authorId: author.id, deletedAt: new Date() });
      for (const hours of [2, 4]) {
        const p = await createPqrs(ctx.prisma, { authorId: author.id, status: 'RESOLVED' });
        await ctx.prisma.pqrs.update({
          where: { id: p.id },
          data: { createdAt: new Date('2026-01-01T10:00:00Z'), resolvedAt: new Date(Date.parse('2026-01-01T10:00:00Z') + hours * 3_600_000) },
        });
      }
      const { body } = await admin.get('/dashboard/admin/overview');
      expect(body.pqrs).toEqual({ filed: 1, inReview: 1, resolved: 2, avgResponseSeconds: 10_800 });
    });
  });

  describe('GET /dashboard/admin/changes', () => {
    it('lists rescheduled and teacher-cancelled sessions, newest change first, without holiday ones', async () => {
      const module = await createModule(ctx.prisma, { name: 'Cálculo' });
      const base = { moduleId: module.id, scheduleId: module.schedules[0].id, teacherId: module.teacherId, roomId: module.roomId };
      const day = (n: number) => new Date(Date.UTC(2030, 2, n, 15));
      const rescheduled = await createSession(ctx.prisma, { ...base, startsAt: day(5), status: 'RESCHEDULED' });
      const byTeacher = await createSession(ctx.prisma, { ...base, startsAt: day(6), status: 'CANCELLED' });
      await ctx.prisma.moduleSession.update({ where: { id: byTeacher.id }, data: { cancelReason: 'TEACHER' } });
      await createSession(ctx.prisma, { ...base, startsAt: day(7), status: 'CANCELLED' }); // holiday: ignored
      await createSession(ctx.prisma, { ...base, startsAt: day(8) }); // untouched: ignored
      await createSession(ctx.prisma, { ...base, startsAt: day(9), status: 'RESCHEDULED', deletedAt: new Date() });
      await ctx.prisma.moduleSession.update({ where: { id: rescheduled.id }, data: { updatedAt: new Date(Date.now() + 60_000) } });

      const { status, body } = await admin.get('/dashboard/admin/changes?limit=5');
      expect(status).toBe(200);
      expect(body.meta).toEqual({ page: 1, limit: 5, total: 2 });
      expect(body.data.map((c: { sessionId: string }) => c.sessionId)).toEqual([rescheduled.id, byTeacher.id]);
      expect(body.data[0]).toMatchObject({ moduleName: 'Cálculo', kind: 'RESCHEDULED', moduleId: module.id });
      expect(body.data[1].kind).toBe('CANCELLED');
    });

    it('pages the list', async () => {
      const module = await createModule(ctx.prisma);
      for (let i = 1; i <= 3; i++) {
        await createSession(ctx.prisma, {
          moduleId: module.id,
          scheduleId: module.schedules[0].id,
          teacherId: module.teacherId,
          roomId: module.roomId,
          startsAt: new Date(Date.UTC(2030, 2, i, 15)),
          status: 'RESCHEDULED',
        });
      }
      const { body } = await admin.get('/dashboard/admin/changes?page=2&limit=2');
      expect(body.meta).toEqual({ page: 2, limit: 2, total: 3 });
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /dashboard/admin/rooms', () => {
    it('is empty without modules', async () => {
      expect((await admin.get('/dashboard/admin/rooms')).body).toEqual({ most: [], least: [] });
    });

    it('ranks rooms by the occupancy of their modules without repeating one', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      await moduleWith(period.id, 10, 9, 'Alta');
      await moduleWith(period.id, 10, 5, 'Media');
      await moduleWith(period.id, 10, 1, 'Baja');
      await createRoom(ctx.prisma, { name: 'Vacía' }); // no modules: ignored

      const { body } = await admin.get('/dashboard/admin/rooms');
      expect(body.most.map((r: { name: string }) => r.name)).toEqual(['Alta', 'Media']);
      expect(body.least.map((r: { name: string }) => r.name)).toEqual(['Baja']);
      expect(body.most[0]).toMatchObject({ percent: 90, modules: 1 });
      for (const r of [...body.most, ...body.least]) expect(r.percent).toBeGreaterThanOrEqual(0);
    });
  });
});
