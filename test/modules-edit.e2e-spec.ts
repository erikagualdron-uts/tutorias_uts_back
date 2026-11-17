import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHoliday,
  createModule,
  createPeriod,
  createRoom,
  createSession,
  createTeacher,
  createUser,
  TEST_PASSWORD,
} from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const DAY = 86_400_000;
const NONE = '00000000-0000-4000-8000-000000000999';
const monday = { dayOfWeek: 1, startTime: '14:00', endTime: '16:00' };
const tuesday = { dayOfWeek: 2, startTime: '14:00', endTime: '16:00' };
const thursday = { dayOfWeek: 4, startTime: '10:00', endTime: '12:00' };

describe('modules: change teacher, edit and delete (US4, US5)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const res = await ctx.http().post('/api/v1/auth/login').send({ email: admin.email, password: TEST_PASSWORD });
    token = res.body.accessToken as string;
  });
  afterAll(() => ctx.close());

  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  // A module created through the API so it has its generated sessions (period of 8 weeks, 2030).
  async function setup(status: 'UPCOMING' | 'ACTIVE' | 'CLOSED' = 'UPCOMING') {
    // periods cannot overlap, so a closed one (a second period in the same test) lives a year later
    const dates = status === 'CLOSED' ? { startsOn: '2031-01-06', endsOn: '2031-03-02' } : { startsOn: '2030-01-07', endsOn: '2030-03-03' };
    const period = await createPeriod(ctx.prisma, { status, ...dates });
    const teacher = await createTeacher(ctx.prisma);
    const room = await createRoom(ctx.prisma);
    const module = await createModule(ctx.prisma, { periodId: period.id, teacherId: teacher.id, roomId: room.id, name: 'Cálculo' });
    const make = (startsAt: Date) =>
      createSession(ctx.prisma, {
        moduleId: module.id,
        scheduleId: module.schedules[0]!.id,
        teacherId: teacher.id,
        roomId: room.id,
        startsAt,
      });
    return { period, teacher, room, module, make };
  }

  describe('change teacher (US4)', () => {
    it('moves the module and its future sessions, and leaves the past ones with the old teacher', async () => {
      const { module, teacher, make } = await setup();
      const past = await make(new Date(Date.now() - 7 * DAY));
      const future = await make(new Date(Date.now() + 7 * DAY));
      const next = await createTeacher(ctx.prisma, { firstName: 'Luis', lastName: 'Gómez' });
      const res = await call('patch', `/modules/${module.id}/teacher`, { teacherId: next.id });
      expect(res.status).toBe(200);
      expect(res.body.teacher).toMatchObject({ id: next.id, firstName: 'Luis', lastName: 'Gómez' });
      const teacherOf = async (id: string) => (await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id } })).teacherId;
      expect(await teacherOf(past.id)).toBe(teacher.id);
      expect(await teacherOf(future.id)).toBe(next.id);
      expect((await ctx.prisma.moduleSchedule.findUniqueOrThrow({ where: { id: module.schedules[0]!.id } })).teacherId).toBe(next.id);
    });

    it('refuses a teacher who is busy at that hour and names the module', async () => {
      const { period, module } = await setup();
      const busy = await createTeacher(ctx.prisma);
      await createModule(ctx.prisma, {
        periodId: period.id,
        teacherId: busy.id,
        name: 'Álgebra',
        schedules: [{ dayOfWeek: 2, startMinute: 900, endMinute: 1020 }],
      });
      const res = await call('patch', `/modules/${module.id}/teacher`, { teacherId: busy.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_TEACHER_CONFLICT');
      expect(res.body.details.conflict).toMatchObject({ moduleName: 'Álgebra', startTime: '15:00' });
    });

    it('refuses an inactive, deleted or non-teacher user, and answers 404 and 400 where due', async () => {
      const { module } = await setup();
      const student = await createUser(ctx.prisma, { role: 'STUDENT' });
      const inactive = await createTeacher(ctx.prisma, { status: 'INACTIVE' });
      const deleted = await createTeacher(ctx.prisma, { deletedAt: new Date() });
      for (const id of [student.id, inactive.id, deleted.id]) {
        const res = await call('patch', `/modules/${module.id}/teacher`, { teacherId: id });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('MODULE_TEACHER_UNAVAILABLE');
      }
      expect((await call('patch', `/modules/${module.id}/teacher`, { teacherId: NONE })).status).toBe(404);
      expect((await call('patch', `/modules/${NONE}/teacher`, { teacherId: module.teacherId })).status).toBe(404);
      expect((await call('patch', `/modules/${module.id}/teacher`, {})).status).toBe(400);
    });

    it('does nothing when the teacher is the same, and is read-only in a closed period', async () => {
      const { module } = await setup();
      expect((await call('patch', `/modules/${module.id}/teacher`, { teacherId: module.teacherId })).status).toBe(200);
      expect(await ctx.prisma.outboxEvent.count()).toBe(0);
      const closed = await setup('CLOSED');
      const other = await createTeacher(ctx.prisma);
      const res = await call('patch', `/modules/${closed.module.id}/teacher`, { teacherId: other.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
    });

    it('records MODULE_TEACHER_CHANGED with the old and the new teacher', async () => {
      const { module, teacher } = await setup();
      ctx.usage.setEnrolled(module.id, 6);
      const next = await createTeacher(ctx.prisma);
      await call('patch', `/modules/${module.id}/teacher`, { teacherId: next.id });
      const [event] = await ctx.prisma.outboxEvent.findMany();
      expect(event).toMatchObject({ type: 'MODULE_TEACHER_CHANGED', moduleId: module.id, processedAt: null });
      expect(event!.payload).toMatchObject({ fromTeacherId: teacher.id, toTeacherId: next.id, enrolled: 6 });
    });
  });

  describe('edit name and description (US5)', () => {
    it('saves them with or without enrolled students', async () => {
      const { module } = await setup();
      ctx.usage.setEnrolled(module.id, 9);
      const res = await call('patch', `/modules/${module.id}`, { name: '  Cálculo II ', description: 'Nuevo' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Cálculo II', description: 'Nuevo', enrolled: 9 });
      expect((await call('patch', `/modules/${module.id}`, { description: '' })).body.description).toBeNull();
      expect((await call('patch', `/modules/${module.id}`, {})).body.name).toBe('Cálculo II');
    });

    it('validates the name, answers 404 and refuses a closed period', async () => {
      const { module } = await setup();
      for (const name of ['   ', 'a'.repeat(121)]) {
        expect((await call('patch', `/modules/${module.id}`, { name })).status).toBe(400);
      }
      expect((await call('patch', `/modules/${NONE}`, { name: 'X' })).status).toBe(404);
      const closed = await setup('CLOSED');
      const res = await call('patch', `/modules/${closed.module.id}`, { name: 'X' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
    });
  });

  describe('replace the weekly schedules (US5)', () => {
    async function viaApi() {
      const base = await setup();
      const created = await call('post', '/modules', {
        periodId: base.period.id,
        name: 'Con sesiones',
        teacherId: base.teacher.id,
        roomId: base.room.id,
        schedules: [{ dayOfWeek: 5, startTime: '08:00', endTime: '10:00' }],
      });
      expect(created.status).toBe(201);
      return { ...base, id: created.body.id as string };
    }

    it('generates the new sessions, drops the future ones of the old slot and keeps the past ones', async () => {
      const { id, teacher, room, period } = await viaApi();
      const old = await ctx.prisma.moduleSchedule.findFirstOrThrow({ where: { moduleId: id } });
      const past = await createSession(ctx.prisma, {
        moduleId: id,
        scheduleId: old.id,
        teacherId: teacher.id,
        roomId: room.id,
        startsAt: new Date(Date.now() - 7 * DAY),
      });
      expect(await ctx.prisma.moduleSession.count({ where: { moduleId: id, deletedAt: null } })).toBe(9);
      await createHoliday(ctx.prisma, { date: '2030-01-21' }); // a Monday

      const res = await call('put', `/modules/${id}/schedules`, { schedules: [monday, thursday] });
      expect(res.status).toBe(200);
      expect(res.body.schedules.map((s: { dayOfWeek: number; sessionsGenerated: number }) => [s.dayOfWeek, s.sessionsGenerated])).toEqual([
        [1, 7], // one Monday is a holiday
        [4, 8],
      ]);
      const live = await ctx.prisma.moduleSession.findMany({ where: { moduleId: id, deletedAt: null } });
      expect(live).toHaveLength(15 + 1);
      expect(live.some((s) => s.id === past.id)).toBe(true);
      expect(live.filter((s) => s.scheduleId === old.id)).toHaveLength(1);
      const slots = await ctx.prisma.moduleSchedule.findMany({ where: { moduleId: id } });
      expect(slots.filter((s) => s.deletedAt !== null)).toHaveLength(1);
      expect(slots.filter((s) => s.deletedAt === null && s.periodId === period.id)).toHaveLength(2);
    });

    it('lets the module move within its own old hours and refuses a clash with another module', async () => {
      const { id, period, teacher, room } = await viaApi();
      expect((await call('put', `/modules/${id}/schedules`, { schedules: [{ dayOfWeek: 5, startTime: '09:00', endTime: '11:00' }] })).status).toBe(200);
      const other = await createTeacher(ctx.prisma);
      await createModule(ctx.prisma, {
        periodId: period.id,
        teacherId: teacher.id,
        name: 'Álgebra',
        schedules: [{ dayOfWeek: 3, startMinute: 600, endMinute: 720 }],
      });
      const byTeacher = await call('put', `/modules/${id}/schedules`, { schedules: [{ dayOfWeek: 3, startTime: '11:00', endTime: '13:00' }] });
      expect(byTeacher.status).toBe(409);
      expect(byTeacher.body.code).toBe('MODULE_TEACHER_CONFLICT');
      await createModule(ctx.prisma, {
        periodId: period.id,
        teacherId: other.id,
        roomId: room.id,
        name: 'Física',
        schedules: [{ dayOfWeek: 4, startMinute: 600, endMinute: 720 }],
      });
      const byRoom = await call('put', `/modules/${id}/schedules`, { schedules: [thursday] });
      expect(byRoom.status).toBe(409);
      expect(byRoom.body.code).toBe('MODULE_ROOM_CONFLICT');
      // a refused change leaves everything as it was
      expect(await ctx.prisma.moduleSchedule.count({ where: { moduleId: id, deletedAt: null } })).toBe(1);
    });

    it('is blocked while there are enrolled students and shows how many', async () => {
      const { id } = await viaApi();
      ctx.usage.setEnrolled(id, 4);
      const res = await call('put', `/modules/${id}/schedules`, { schedules: [tuesday] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_HAS_ENROLLMENTS');
      expect(res.body.details.enrolled).toBe(4);
      expect(await ctx.prisma.moduleSession.count({ where: { moduleId: id, deletedAt: null } })).toBe(8);
    });

    it('validates the slots and refuses a closed period', async () => {
      const { id } = await viaApi();
      expect((await call('put', `/modules/${id}/schedules`, { schedules: [] })).status).toBe(400);
      const invalid = await call('put', `/modules/${id}/schedules`, { schedules: [{ ...tuesday, endTime: '13:00' }] });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe('MODULE_SCHEDULE_INVALID');
      const overlap = await call('put', `/modules/${id}/schedules`, { schedules: [tuesday, { ...tuesday, startTime: '15:00', endTime: '17:00' }] });
      expect(overlap.body.code).toBe('MODULE_SCHEDULE_SELF_OVERLAP');
      const closed = await setup('CLOSED');
      const res = await call('put', `/modules/${closed.module.id}/schedules`, { schedules: [tuesday] });
      expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
    });
  });

  describe('delete (US5)', () => {
    it('hides the module, keeps the rows and frees the teacher and the room', async () => {
      const { module, teacher, room, period, make } = await setup();
      const past = await make(new Date(Date.now() - 7 * DAY));
      const future = await make(new Date(Date.now() + 7 * DAY));
      expect((await call('delete', `/modules/${module.id}`)).status).toBe(204);
      const row = await ctx.prisma.module.findUniqueOrThrow({ where: { id: module.id } });
      expect(row.deletedAt).not.toBeNull();
      expect((await ctx.prisma.moduleSchedule.findFirstOrThrow({ where: { moduleId: module.id } })).deletedAt).not.toBeNull();
      expect((await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: future.id } })).deletedAt).not.toBeNull();
      expect((await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: past.id } })).deletedAt).toBeNull();
      expect((await call('get', `/modules/${module.id}`)).status).toBe(404);
      expect((await call('get', `/modules?periodId=${period.id}`)).body.data).toEqual([]);
      const again = await call('post', '/modules', {
        periodId: period.id,
        name: 'Otra vez',
        teacherId: teacher.id,
        roomId: room.id,
        schedules: [tuesday],
      });
      expect(again.status).toBe(201);
    });

    it('is blocked with enrolled students, in a closed period and when the module does not exist', async () => {
      const { module } = await setup();
      ctx.usage.setEnrolled(module.id, 2);
      const blocked = await call('delete', `/modules/${module.id}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ code: 'MODULE_HAS_ENROLLMENTS', details: { enrolled: 2 } });
      expect((await ctx.prisma.module.findUniqueOrThrow({ where: { id: module.id } })).deletedAt).toBeNull();
      const closed = await setup('CLOSED');
      expect((await call('delete', `/modules/${closed.module.id}`)).body.code).toBe('PERIOD_CLOSED_READ_ONLY');
      expect((await call('delete', `/modules/${NONE}`)).status).toBe(404);
    });
  });
});
