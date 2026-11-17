import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bogotaCalendarDay } from '../src/common/clock.js';
import {
  createHoliday,
  createModule,
  createPeriod,
  createRoom,
  createTeacher,
  createUser,
  TEST_PASSWORD,
} from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const DAY_MS = 86_400_000;
// 2030-01-07 is a Monday. The period below has exactly 8 weeks: Tuesdays 01-08 ... 02-26.
const PERIOD = { startsOn: '2030-01-07', endsOn: '2030-03-03' };
const tuesday = { dayOfWeek: 2, startTime: '14:00', endTime: '16:00' };
const thursday = { dayOfWeek: 4, startTime: '10:00', endTime: '12:00' };

describe('modules: create (US1)', () => {
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

  const create = (body: unknown) =>
    ctx.http().post('/api/v1/modules').set('Authorization', `Bearer ${token}`).send(body as object);

  async function base(periodStatus: 'UPCOMING' | 'ACTIVE' | 'CLOSED' = 'UPCOMING') {
    const period = await createPeriod(ctx.prisma, { ...PERIOD, status: periodStatus });
    const teacher = await createTeacher(ctx.prisma);
    const room = await createRoom(ctx.prisma, { capacity: 30 });
    const body = (extra: Record<string, unknown> = {}) => ({
      periodId: period.id,
      name: 'Cálculo I',
      teacherId: teacher.id,
      roomId: room.id,
      schedules: [tuesday],
      ...extra,
    });
    return { period, teacher, room, body };
  }

  const moduleCount = () => ctx.prisma.module.count();

  describe('success', () => {
    it('creates the module with the room capacity as its cupo and one session per week', async () => {
      const { period, teacher, room, body } = await base();
      const res = await create(body({ description: 'Refuerzo de límites' }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Cálculo I',
        description: 'Refuerzo de límites',
        periodId: period.id,
        periodStatus: 'UPCOMING',
        capacity: 30,
        enrolled: 0,
        teacher: { id: teacher.id },
        room: { id: room.id, capacity: 30 },
        canChangeSchedules: true,
        canDelete: true,
        readOnlyReason: null,
        roomUnavailable: false,
        teacherUnavailable: false,
      });
      expect(res.body.schedules).toHaveLength(1);
      expect(res.body.schedules[0]).toMatchObject({ ...tuesday, sessionsGenerated: 8 });

      const sessions = await ctx.prisma.moduleSession.findMany({
        where: { moduleId: res.body.id },
        orderBy: { startsAt: 'asc' },
      });
      expect(sessions).toHaveLength(8);
      // 14:00 and 16:00 in Bogota are 19:00 and 21:00 UTC
      expect(sessions[0]!.startsAt.toISOString()).toBe('2030-01-08T19:00:00.000Z');
      expect(sessions[0]!.endsAt.toISOString()).toBe('2030-01-08T21:00:00.000Z');
      expect(sessions[7]!.startsAt.toISOString()).toBe('2030-02-26T19:00:00.000Z');
      expect(sessions.every((s) => s.status === 'SCHEDULED' && s.cancelReason === null)).toBe(true);
      expect(sessions.every((s) => s.teacherId === teacher.id && s.roomId === room.id)).toBe(true);
      expect(sessions.every((s) => s.originalStartsAt.getTime() === s.startsAt.getTime())).toBe(true);

      // the denormalized columns the exclusion constraints use
      const slot = await ctx.prisma.moduleSchedule.findFirstOrThrow({ where: { moduleId: res.body.id } });
      expect(slot).toMatchObject({
        periodId: period.id,
        teacherId: teacher.id,
        roomId: room.id,
        dayOfWeek: 2,
        startMinute: 840,
        endMinute: 960,
      });
    });

    it('generates the sessions of every weekly slot', async () => {
      const { body } = await base();
      const res = await create(body({ schedules: [tuesday, thursday] }));
      expect(res.status).toBe(201);
      expect(res.body.schedules.map((s: { sessionsGenerated: number }) => s.sessionsGenerated)).toEqual([8, 8]);
      expect(await ctx.prisma.moduleSession.count({ where: { moduleId: res.body.id } })).toBe(16);
    });

    it('accepts a description left out or null', async () => {
      const { body } = await base();
      const res = await create(body({ description: null }));
      expect(res.status).toBe(201);
      expect(res.body.description).toBeNull();
    });

    it('allows a period that is already active', async () => {
      const { body } = await base('ACTIVE');
      expect((await create(body())).status).toBe(201);
    });

    it('allows back-to-back modules: one ends exactly when the other starts', async () => {
      const { period, teacher, room, body } = await base();
      await createModule(ctx.prisma, {
        periodId: period.id,
        teacherId: teacher.id,
        roomId: room.id,
        schedules: [{ dayOfWeek: 2, startMinute: 840, endMinute: 960 }],
      });
      const res = await create(body({ schedules: [{ dayOfWeek: 2, startTime: '16:00', endTime: '18:00' }] }));
      expect(res.status).toBe(201);
    });

    it('allows the same teacher, room and hour in a different period', async () => {
      const { teacher, room, body } = await base();
      expect((await create(body())).status).toBe(201);
      const other = await createPeriod(ctx.prisma, { startsOn: '2030-03-04', endsOn: '2030-06-30' });
      const res = await create(body({ periodId: other.id }));
      expect(res.status).toBe(201);
      expect(res.body.teacher.id).toBe(teacher.id);
      expect(res.body.room.id).toBe(room.id);
    });

    it('frees the teacher and the room once the module is deleted', async () => {
      const { period, teacher, room, body } = await base();
      const old = await createModule(ctx.prisma, {
        periodId: period.id,
        teacherId: teacher.id,
        roomId: room.id,
        schedules: [{ dayOfWeek: 2, startMinute: 840, endMinute: 960 }],
      });
      const deletedAt = new Date();
      await ctx.prisma.module.update({ where: { id: old.id }, data: { deletedAt } });
      await ctx.prisma.moduleSchedule.updateMany({ where: { moduleId: old.id }, data: { deletedAt } });
      expect((await create(body())).status).toBe(201);
    });
  });

  describe('sessions of the period', () => {
    it('skips the dates registered as holidays and lists them in the detail', async () => {
      const { body } = await base();
      await createHoliday(ctx.prisma, { date: '2030-01-22' }); // a Tuesday inside the period
      await createHoliday(ctx.prisma, { date: '2030-01-23' }); // a Wednesday: not this module's day
      const res = await create(body());
      expect(res.status).toBe(201);
      expect(res.body.schedules[0].sessionsGenerated).toBe(7);
      const dates = (
        await ctx.prisma.moduleSession.findMany({ where: { moduleId: res.body.id } })
      ).map((s) => s.startsAt.toISOString().slice(0, 10));
      expect(dates).not.toContain('2030-01-22');
      expect(res.body.holidayDates).toEqual(['2030-01-22']);
    });

    it('only creates the sessions that have not started when the period is under way', async () => {
      // Period around today; the module meets on tomorrow's weekday, so every session of that
      // weekday up to today is past and every one from tomorrow on is in the future, whatever the hour.
      const today = bogotaCalendarDay(ctx.clock.now());
      const tomorrow = new Date(today.getTime() + DAY_MS);
      const startsOn = new Date(today.getTime() - 21 * DAY_MS);
      const endsOn = new Date(today.getTime() + 28 * DAY_MS);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const period = await createPeriod(ctx.prisma, {
        startsOn: iso(startsOn),
        endsOn: iso(endsOn),
        status: 'ACTIVE',
      });
      const teacher = await createTeacher(ctx.prisma);
      const room = await createRoom(ctx.prisma);
      const weekday = ((tomorrow.getUTCDay() + 6) % 7) + 1;
      const res = await create({
        periodId: period.id,
        name: 'En curso',
        teacherId: teacher.id,
        roomId: room.id,
        schedules: [{ dayOfWeek: weekday, startTime: '09:00', endTime: '10:00' }],
      });
      expect(res.status).toBe(201);
      let expected = 0;
      for (let d = tomorrow; d.getTime() <= endsOn.getTime(); d = new Date(d.getTime() + 7 * DAY_MS)) expected++;
      expect(res.body.schedules[0].sessionsGenerated).toBe(expected);
      const rows = await ctx.prisma.moduleSession.findMany({ where: { moduleId: res.body.id } });
      expect(rows).toHaveLength(expected);
      expect(rows.every((s) => s.startsAt.getTime() > ctx.clock.now().getTime())).toBe(true);
    });

    it('saves a module with no sessions when the period is shorter than a week and misses the day', async () => {
      const period = await createPeriod(ctx.prisma, { startsOn: '2030-01-09', endsOn: '2030-01-11' }); // Wed to Fri
      const teacher = await createTeacher(ctx.prisma);
      const room = await createRoom(ctx.prisma);
      const res = await create({
        periodId: period.id,
        name: 'Corto',
        teacherId: teacher.id,
        roomId: room.id,
        schedules: [tuesday],
      });
      expect(res.status).toBe(201);
      expect(res.body.schedules[0].sessionsGenerated).toBe(0);
      expect(await ctx.prisma.moduleSession.count({ where: { moduleId: res.body.id } })).toBe(0);
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty name', { name: '   ' }],
      ['a name longer than 120 characters', { name: 'a'.repeat(121) }],
      ['a description longer than 1000 characters', { description: 'a'.repeat(1001) }],
      ['no schedules', { schedules: [] }],
      ['schedules left out', { schedules: undefined }],
      ['a day below 1', { schedules: [{ ...tuesday, dayOfWeek: 0 }] }],
      ['a day above 7', { schedules: [{ ...tuesday, dayOfWeek: 8 }] }],
      ['a time of 24:00', { schedules: [{ ...tuesday, endTime: '24:00' }] }],
      ['a time without leading zero', { schedules: [{ ...tuesday, startTime: '9:00' }] }],
      ['an unknown field', { capacity: 99 }],
      ['a teacher that is not an id', { teacherId: 'abc' }],
    ])('rejects %s', async (_label, extra) => {
      const { body } = await base();
      const res = await create(body(extra));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await moduleCount()).toBe(0);
    });

    it.each([
      ['an end equal to the start', { startTime: '14:00', endTime: '14:00' }],
      ['an end before the start', { startTime: '16:00', endTime: '14:00' }],
      ['a slot that would cross midnight', { startTime: '23:00', endTime: '01:00' }],
    ])('rejects %s with the rule', async (_label, times) => {
      const { body } = await base();
      const res = await create(body({ schedules: [{ dayOfWeek: 2, ...times }] }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('MODULE_SCHEDULE_INVALID');
      expect(await moduleCount()).toBe(0);
    });

    it.each([
      ['starting before 06:00', { startTime: '05:59', endTime: '08:00' }],
      ['ending after 18:00', { startTime: '17:00', endTime: '18:01' }],
      ['held at night', { startTime: '19:00', endTime: '21:00' }],
    ])('rejects a slot %s and names the hours', async (_label, times) => {
      const { body } = await base();
      const res = await create(body({ schedules: [{ dayOfWeek: 2, ...times }] }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('MODULE_SCHEDULE_OUT_OF_HOURS');
      expect(res.body.details).toEqual({ earliest: '06:00', latest: '18:00' });
      expect(await moduleCount()).toBe(0);
    });

    it('accepts a slot from 06:00 to 18:00 exactly', async () => {
      const { body } = await base();
      const res = await create(body({ schedules: [{ dayOfWeek: 2, startTime: '06:00', endTime: '18:00' }] }));
      expect(res.status).toBe(201);
    });

    it('rejects two slots of the same module that overlap, but not two that touch', async () => {
      const { body } = await base();
      const overlap = await create(
        body({ schedules: [tuesday, { dayOfWeek: 2, startTime: '15:00', endTime: '17:00' }] }),
      );
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('MODULE_SCHEDULE_SELF_OVERLAP');
      expect(await moduleCount()).toBe(0);
      const touching = await create(
        body({ schedules: [tuesday, { dayOfWeek: 2, startTime: '16:00', endTime: '18:00' }] }),
      );
      expect(touching.status).toBe(201);
    });

    it('answers 404 for a period, teacher or room that does not exist', async () => {
      const { body } = await base();
      const missing = '00000000-0000-4000-8000-000000000999';
      for (const field of ['periodId', 'teacherId', 'roomId']) {
        const res = await create(body({ [field]: missing }));
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      expect(await moduleCount()).toBe(0);
    });
  });

  describe('conflicts', () => {
    it('rejects a teacher who has another module at that hour and names it', async () => {
      const { period, teacher, body } = await base();
      await createModule(ctx.prisma, {
        periodId: period.id,
        teacherId: teacher.id,
        name: 'Álgebra',
        schedules: [{ dayOfWeek: 2, startMinute: 840, endMinute: 960 }],
      });
      const otherRoom = await createRoom(ctx.prisma);
      const res = await create(
        body({ roomId: otherRoom.id, schedules: [{ dayOfWeek: 2, startTime: '15:00', endTime: '17:00' }] }),
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_TEACHER_CONFLICT');
      expect(res.body.details.conflict).toEqual({
        moduleName: 'Álgebra',
        dayOfWeek: 2,
        startTime: '14:00',
        endTime: '16:00',
      });
      expect(await moduleCount()).toBe(1);
    });

    it('rejects a room that is busy at that hour and names the module', async () => {
      const { period, room, body } = await base();
      await createModule(ctx.prisma, {
        periodId: period.id,
        roomId: room.id,
        name: 'Física',
        schedules: [{ dayOfWeek: 2, startMinute: 780, endMinute: 900 }],
      });
      const otherTeacher = await createTeacher(ctx.prisma);
      const res = await create(body({ teacherId: otherTeacher.id }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_ROOM_CONFLICT');
      expect(res.body.details.conflict).toMatchObject({ moduleName: 'Física', dayOfWeek: 2 });
      expect(await moduleCount()).toBe(1);
    });

    it('checks every slot: the second slot can be the one that conflicts', async () => {
      const { period, teacher, body } = await base();
      await createModule(ctx.prisma, {
        periodId: period.id,
        teacherId: teacher.id,
        schedules: [{ dayOfWeek: 4, startMinute: 600, endMinute: 720 }],
      });
      const otherRoom = await createRoom(ctx.prisma);
      const res = await create(body({ roomId: otherRoom.id, schedules: [tuesday, thursday] }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_TEACHER_CONFLICT');
      expect(await moduleCount()).toBe(1);
    });
  });

  describe('who can be assigned', () => {
    it.each([
      ['an inactive teacher', { status: 'INACTIVE' as const }],
      ['a deleted teacher', { deletedAt: new Date() }],
    ])('rejects %s', async (_label, overrides) => {
      const { body } = await base();
      const teacher = await createTeacher(ctx.prisma, overrides);
      const res = await create(body({ teacherId: teacher.id }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_TEACHER_UNAVAILABLE');
    });

    it('rejects a user that is not a teacher', async () => {
      const { body } = await base();
      const student = await createUser(ctx.prisma, { role: 'STUDENT' });
      const res = await create(body({ teacherId: student.id }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_TEACHER_UNAVAILABLE');
    });

    it.each([
      ['an inactive room', { status: 'INACTIVE' as const }],
      ['a deleted room', { deletedAt: new Date() }],
    ])('rejects %s', async (_label, overrides) => {
      const { body } = await base();
      const room = await createRoom(ctx.prisma, overrides);
      const res = await create(body({ roomId: room.id }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_ROOM_UNAVAILABLE');
    });
  });

  describe('closed period', () => {
    it('is read-only: nothing is created', async () => {
      const { body } = await base('CLOSED');
      const res = await create(body());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
      expect(await moduleCount()).toBe(0);
      expect(await ctx.prisma.moduleSchedule.count()).toBe(0);
      expect(await ctx.prisma.moduleSession.count()).toBe(0);
    });

    it('treats a period whose last day has passed as closed', async () => {
      const period = await createPeriod(ctx.prisma, {
        startsOn: '2020-01-06',
        endsOn: '2020-03-01',
        status: 'ACTIVE',
      });
      const teacher = await createTeacher(ctx.prisma);
      const room = await createRoom(ctx.prisma);
      const res = await create({
        periodId: period.id,
        name: 'Vencido',
        teacherId: teacher.id,
        roomId: room.id,
        schedules: [tuesday],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
      expect(await moduleCount()).toBe(0);
    });
  });
});
