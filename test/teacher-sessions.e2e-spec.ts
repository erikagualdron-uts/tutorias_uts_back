import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAbsence, createEnrollment, createPeriod, createSession, createStudent } from './utils/factories.js';
import { activePeriod, moduleWithSessions } from './utils/enrollment.js';
import { loginTeacher, teacherApi } from './utils/teacher.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

interface Actions {
  id: string;
  canReschedule: boolean;
  canCancel: boolean;
  canRestore: boolean;
  blockReason: string | null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('teacher schedule: modules and sessions', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  describe('GET /teacher/modules', () => {
    it('lists only the modules of the active period that the teacher dictates, with the real enrolled count', async () => {
      const period = await activePeriod(ctx);
      const upcoming = await createPeriod(ctx.prisma, { startsOn: '2031-01-01', endsOn: '2031-06-30', status: 'UPCOMING' });
      const teacher = await loginTeacher(ctx);
      const other = await loginTeacher(ctx);
      const mine = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, name: 'Cálculo I', capacity: 10 });
      await moduleWithSessions(ctx, period.id, { teacherId: other.user.id, name: 'De otro' });
      await moduleWithSessions(ctx, upcoming.id, { teacherId: teacher.user.id, name: 'Próximo' });
      for (let i = 0; i < 3; i++) {
        await createEnrollment(ctx.prisma, { studentId: (await createStudent(ctx.prisma)).id, moduleId: mine.module.id });
      }
      const res = await teacherApi(ctx, teacher).modules();
      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ periodId: period.id, total: 1, page: 1 });
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: mine.module.id,
        name: 'Cálculo I',
        enrolled: 3,
        capacity: 10,
        readOnly: false,
        schedules: [{ dayOfWeek: 2, startTime: '14:00', endTime: '16:00' }],
        room: { id: mine.room.id, capacity: 10 },
      });
      expect(res.body.data[0].nextSession.id).toBe(mine.sessions[0].id);
    });

    it('answers an empty page with a null period when none is active, and paginates', async () => {
      const teacher = await loginTeacher(ctx);
      expect((await teacherApi(ctx, teacher).modules()).body).toMatchObject({ data: [], meta: { periodId: null, total: 0 } });
      const period = await activePeriod(ctx);
      await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, name: 'A' });
      await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, name: 'B', slot: { dayOfWeek: 3, startMinute: 600, endMinute: 720 } });
      const page = await teacherApi(ctx, teacher).modules('?limit=1&page=2');
      expect(page.body.data.map((m: { name: string }) => m.name)).toEqual(['B']);
      expect(page.body.meta.total).toBe(2);
    });
  });

  describe('GET /teacher/sessions', () => {
    it('lists only the teacher\'s own future sessions in order, with filters and pagination', async () => {
      const period = await activePeriod(ctx);
      const teacher = await loginTeacher(ctx);
      const other = await loginTeacher(ctx);
      const a = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, name: 'A', hoursAhead: [72, 24] });
      const b = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, name: 'B', hoursAhead: [48], slot: { dayOfWeek: 3, startMinute: 600, endMinute: 720 } });
      const strangers = await moduleWithSessions(ctx, period.id, { teacherId: other.user.id, name: 'Ajeno', slot: { dayOfWeek: 4, startMinute: 600, endMinute: 720 } });
      // a past session never shows
      await createSession(ctx.prisma, {
        moduleId: a.module.id,
        scheduleId: a.module.schedules[0].id,
        teacherId: teacher.user.id,
        roomId: a.room.id,
        startsAt: new Date(Date.now() - 24 * HOUR),
      });
      const api = teacherApi(ctx, teacher);
      const all = await api.sessions();
      expect(all.status).toBe(200);
      expect(all.body.data.map((s: { moduleName: string }) => s.moduleName)).toEqual(['A', 'B', 'A']);
      expect(all.body.meta).toMatchObject({ total: 3, changeLeadMinutes: 120 });
      expect(all.body.data.some((s: { id: string }) => strangers.sessions.some((x) => x.id === s.id))).toBe(false);
      expect((await api.sessions(`?moduleId=${b.module.id}`)).body.data).toHaveLength(1);
      expect((await api.sessions(`?moduleId=${strangers.module.id}`)).body.data).toEqual([]);
      expect((await api.sessions('?limit=2&page=2')).body.data).toHaveLength(1);
      const day = new Date(Date.now() + 48 * HOUR - 5 * HOUR).toISOString().slice(0, 10);
      expect((await api.sessions(`?from=${day}&to=${day}`)).body.data.map((s: { moduleName: string }) => s.moduleName)).toEqual(['B']);
    });

    it('moves a "from" in the past to now: only future sessions, never past ones with 0 attendees', async () => {
      const period = await activePeriod(ctx);
      const teacher = await loginTeacher(ctx);
      const m = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, hoursAhead: [24] });
      await createSession(ctx.prisma, {
        moduleId: m.module.id,
        scheduleId: m.module.schedules[0].id,
        teacherId: teacher.user.id,
        roomId: m.room.id,
        startsAt: new Date(Date.now() - 48 * HOUR),
      });
      const res = await teacherApi(ctx, teacher).sessions('?from=2020-01-01');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(m.sessions[0].id);
    });

    it('counts attendees (only a number): fewer with an absence, none for an inactive account, none when cancelled', async () => {
      const period = await activePeriod(ctx);
      const teacher = await loginTeacher(ctx);
      const m = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, hoursAhead: [48, 216] });
      const students = [];
      for (let i = 0; i < 4; i++) {
        const s = await createStudent(ctx.prisma);
        students.push({ s, e: await createEnrollment(ctx.prisma, { studentId: s.id, moduleId: m.module.id }) });
      }
      await createAbsence(ctx.prisma, { enrollmentId: students[0].e.id, sessionId: m.sessions[0].id });
      await ctx.prisma.user.update({ where: { id: students[1].s.id }, data: { status: 'INACTIVE' } });
      const res = await teacherApi(ctx, teacher).sessions();
      const [first, second] = res.body.data as { id: string; attendees: number }[];
      expect(first.attendees).toBe(2);
      expect(second.attendees).toBe(3);
      const text = JSON.stringify(res.body);
      for (const { s } of students) {
        expect(text).not.toContain(s.id);
        expect(text).not.toContain(s.email);
      }
      await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0].id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
      const cancelled = (await teacherApi(ctx, teacher).sessions()).body.data[0];
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'TEACHER', attendees: 0 });
    });

    it('shows the teacher and room each session is held with after the CAE reassigns the module (D-086)', async () => {
      const period = await activePeriod(ctx);
      const teacher = await loginTeacher(ctx);
      const successor = await loginTeacher(ctx);
      const m = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, hoursAhead: [48] });
      await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0].id }, data: { teacherId: successor.user.id } });
      expect((await teacherApi(ctx, teacher).sessions()).body.data).toEqual([]);
      const theirs = (await teacherApi(ctx, successor).sessions()).body.data;
      expect(theirs).toHaveLength(1);
      expect(theirs[0].room.id).toBe(m.room.id);
    });

    it('tells what can be done and the rule that blocks it', async () => {
      const now = new Date();
      ctx.clock.freezeAt(now);
      const period = await activePeriod(ctx);
      const closed = await createPeriod(ctx.prisma, { startsOn: '2020-01-01', endsOn: '2020-06-30', status: 'CLOSED' });
      const teacher = await loginTeacher(ctx);
      const m = await moduleWithSessions(ctx, period.id, { teacherId: teacher.user.id, hoursAhead: [] });
      const make = (minutes: number, extra: object = {}) =>
        createSession(ctx.prisma, {
          moduleId: m.module.id,
          scheduleId: m.module.schedules[0].id,
          teacherId: teacher.user.id,
          roomId: m.room.id,
          startsAt: new Date(now.getTime() + minutes * MIN),
          ...extra,
        });
      const ok = await make(121);
      const edge = await make(120 + 24 * 60);
      const near = await make(119 + 48 * 60 - 48 * 60);
      const holiday = await make(5 * 24 * 60, { status: 'CANCELLED' });
      const byTeacher = await make(6 * 24 * 60, { status: 'CANCELLED' });
      await ctx.prisma.moduleSession.update({ where: { id: byTeacher.id }, data: { cancelReason: 'TEACHER' } });
      const old = await moduleWithSessions(ctx, closed.id, { teacherId: teacher.user.id, hoursAhead: [] });
      const inClosed = await createSession(ctx.prisma, {
        moduleId: old.module.id,
        scheduleId: old.module.schedules[0].id,
        teacherId: teacher.user.id,
        roomId: old.room.id,
        startsAt: new Date(now.getTime() + 7 * 24 * 60 * MIN),
      });
      const by = Object.fromEntries(((await teacherApi(ctx, teacher).sessions()).body.data as Actions[]).map((s) => [s.id, s]));
      expect(by[ok.id]).toMatchObject({ canReschedule: true, canCancel: true, canRestore: false, blockReason: null });
      expect(by[edge.id].canCancel).toBe(true);
      expect(by[near.id]).toMatchObject({ canReschedule: false, canCancel: false, blockReason: 'WINDOW_PASSED' });
      expect(by[holiday.id]).toMatchObject({ canRestore: false, blockReason: 'CANCELLED_BY_OTHER' });
      expect(by[byTeacher.id]).toMatchObject({ canRestore: true, canCancel: false, blockReason: null });
      expect(by[inClosed.id]).toMatchObject({ canReschedule: false, blockReason: 'PERIOD_CLOSED' });
    });

    it('answers 400 for malformed dates and ids', async () => {
      const teacher = await loginTeacher(ctx);
      const api = teacherApi(ctx, teacher);
      expect((await api.sessions('?from=hoy')).status).toBe(400);
      expect((await api.sessions('?to=2030-13-45')).status).toBe(400);
      expect((await api.sessions('?moduleId=nope')).status).toBe(400);
    });
  });
});
