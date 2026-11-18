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

const NONE = '00000000-0000-4000-8000-000000000999';
const PERIOD = { startsOn: '2030-01-07', endsOn: '2030-03-03' }; // Tuesdays 2030-01-08 ... 02-26
const tuesday = { dayOfWeek: 2, startTime: '14:00', endTime: '16:00' };

describe('holidays (US6)', () => {
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

  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const sessionOn = (moduleId: string, day: string) =>
    ctx.prisma.moduleSession.findFirstOrThrow({
      where: { moduleId, deletedAt: null, startsAt: { gte: new Date(`${day}T05:00:00Z`), lt: new Date(`${day}T23:59:00Z`) } },
    });
  const events = (type: string) => ctx.prisma.outboxEvent.findMany({ where: { type: type as never } });

  // A module made through the API, so it has its generated sessions.
  async function moduleOf(periodStatus: 'UPCOMING' | 'ACTIVE' = 'UPCOMING') {
    const period = await createPeriod(ctx.prisma, { ...PERIOD, status: periodStatus });
    const teacher = await createTeacher(ctx.prisma);
    const room = await createRoom(ctx.prisma);
    const res = await call('post', '/modules', { periodId: period.id, name: 'Cálculo', teacherId: teacher.id, roomId: room.id, schedules: [tuesday] });
    expect(res.status).toBe(201);
    return { period, teacher, room, id: res.body.id as string };
  }

  describe('calendar', () => {
    it('registers, lists by year in date order and marks the source', async () => {
      await call('post', '/holidays', { date: '2030-12-25', name: ' Navidad ' });
      const created = await call('post', '/holidays', { date: '2030-01-01', name: 'Año Nuevo' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        holiday: { date: '2030-01-01', name: 'Año Nuevo', source: 'MANUAL', isPast: false },
        cancelledSessions: 0,
      });
      await call('post', '/holidays', { date: '2031-01-01', name: 'Otro año' });
      const list = await call('get', '/holidays?year=2030');
      expect(list.body.data.map((h: { date: string; name: string }) => `${h.date} ${h.name}`)).toEqual(['2030-01-01 Año Nuevo', '2030-12-25 Navidad']);
    });

    it('refuses a repeated date, a past date, a bad date and a bad year', async () => {
      await call('post', '/holidays', { date: '2030-01-01', name: 'Uno' });
      expect((await call('post', '/holidays', { date: '2030-01-01', name: 'Otro' })).body.code).toBe('HOLIDAY_DATE_TAKEN');
      const past = await call('post', '/holidays', { date: '2020-05-01', name: 'Viejo' });
      expect(past.status).toBe(409);
      expect(past.body.code).toBe('HOLIDAY_IN_PAST');
      expect((await call('post', '/holidays', { date: '2030-02-30', name: 'X' })).status).toBe(400);
      expect((await call('post', '/holidays', { date: '2030-02-01', name: '  ' })).status).toBe(400);
      expect((await call('get', '/holidays?year=1999')).status).toBe(400);
    });

    it('lets the same date be registered again after the holiday is deleted', async () => {
      const first = await call('post', '/holidays', { date: '2030-01-01', name: 'Uno' });
      expect((await call('delete', `/holidays/${first.body.holiday.id}`)).status).toBe(200);
      expect((await ctx.prisma.holiday.findUniqueOrThrow({ where: { id: first.body.holiday.id } })).deletedAt).not.toBeNull();
      expect((await call('post', '/holidays', { date: '2030-01-01', name: 'Dos' })).status).toBe(201);
    });

    it('does not edit or delete a holiday that has passed', async () => {
      const old = await createHoliday(ctx.prisma, { date: '2020-05-01' });
      expect((await call('get', '/holidays?year=2020')).body.data[0].isPast).toBe(true);
      for (const res of [await call('patch', `/holidays/${old.id}`, { date: '2030-01-01', name: 'X' }), await call('delete', `/holidays/${old.id}`)]) {
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('HOLIDAY_IN_PAST');
      }
      expect((await call('patch', `/holidays/${NONE}`, { date: '2030-01-01', name: 'X' })).status).toBe(404);
    });
  });

  describe('effect on sessions', () => {
    it('cancels the future sessions of that date, tells the module and leaves the rest', async () => {
      const { id } = await moduleOf();
      const res = await call('post', '/holidays', { date: '2030-01-22', name: 'Festivo' });
      expect(res.body.cancelledSessions).toBe(1);
      const cancelled = await sessionOn(id, '2030-01-22');
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'HOLIDAY', holidayId: res.body.holiday.id });
      expect(await ctx.prisma.moduleSession.count({ where: { moduleId: id, status: 'SCHEDULED' } })).toBe(7);
      const [event] = await events('SESSIONS_CANCELLED_HOLIDAY');
      expect(event).toMatchObject({ moduleId: id, processedAt: null });
      expect(event!.payload).toEqual({ date: '2030-01-22', sessions: 1 });
    });

    it('ignores a date without sessions and a module whose period is closed', async () => {
      const { id } = await moduleOf();
      expect((await call('post', '/holidays', { date: '2030-01-23', name: 'Miércoles' })).body.cancelledSessions).toBe(0);
      expect(await events('SESSIONS_CANCELLED_HOLIDAY')).toHaveLength(0);

      const closed = await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2031-01-06', endsOn: '2031-03-02' });
      const old = await createModule(ctx.prisma, { periodId: closed.id });
      const session = await createSession(ctx.prisma, {
        moduleId: old.id,
        scheduleId: old.schedules[0]!.id,
        teacherId: old.teacherId,
        roomId: old.roomId,
        startsAt: new Date('2031-01-07T19:00:00Z'),
      });
      expect((await call('post', '/holidays', { date: '2031-01-07', name: 'Cerrado' })).body.cancelledSessions).toBe(0);
      expect((await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe('SCHEDULED');
      expect(id).toBeTruthy();
    });

    it('gives the sessions back when the holiday is deleted and says so', async () => {
      const { id } = await moduleOf();
      const holiday = (await call('post', '/holidays', { date: '2030-01-22', name: 'Festivo' })).body.holiday;
      const res = await call('delete', `/holidays/${holiday.id}`);
      expect(res.body).toEqual({ restored: 1, generated: 0, notRestored: [] });
      expect(await sessionOn(id, '2030-01-22')).toMatchObject({ status: 'SCHEDULED', cancelReason: null, holidayId: null });
      const [event] = await events('SESSIONS_RESTORED_HOLIDAY');
      expect(event!.payload).toEqual({ date: '2030-01-22', restored: 1, generated: 0 });
    });

    it('cancels a session a teacher moved onto the day and gives it back rescheduled', async () => {
      const { id, teacher, room } = await moduleOf();
      const moved = await sessionOn(id, '2030-01-15');
      // moved from Tuesday 2030-01-15 14:00 to Tuesday 2030-01-22 16:00 would overlap; use Wednesday 01-23 instead
      const to = new Date('2030-01-23T19:00:00Z');
      await ctx.prisma.moduleSession.update({
        where: { id: moved.id },
        data: { startsAt: to, endsAt: new Date(to.getTime() + 2 * 3_600_000), status: 'RESCHEDULED' },
      });
      const holiday = (await call('post', '/holidays', { date: '2030-01-23', name: 'Miércoles' })).body;
      expect(holiday.cancelledSessions).toBe(1);
      expect(await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: moved.id } })).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'HOLIDAY',
      });
      const res = await call('delete', `/holidays/${holiday.holiday.id}`);
      expect(res.body.restored).toBe(1);
      const back = await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: moved.id } });
      expect(back).toMatchObject({ status: 'RESCHEDULED', cancelReason: null, holidayId: null });
      expect(back.startsAt.toISOString()).toBe(to.toISOString());
      expect(teacher.id).toBeTruthy();
      expect(room.id).toBeTruthy();
    });

    it('leaves a session the teacher cancelled alone, both when the holiday is created and deleted', async () => {
      const { id } = await moduleOf();
      const session = await sessionOn(id, '2030-01-22');
      await ctx.prisma.moduleSession.update({ where: { id: session.id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
      const holiday = (await call('post', '/holidays', { date: '2030-01-22', name: 'Festivo' })).body;
      expect(holiday.cancelledSessions).toBe(0);
      expect(await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'TEACHER',
        holidayId: null,
      });
      await call('delete', `/holidays/${holiday.holiday.id}`);
      expect(await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'TEACHER',
      });
    });

    it('generates the sessions that were never created because the holiday already existed', async () => {
      const holiday = (await call('post', '/holidays', { date: '2030-01-22', name: 'Festivo' })).body.holiday;
      const { id } = await moduleOf();
      expect(await ctx.prisma.moduleSession.count({ where: { moduleId: id } })).toBe(7);
      const res = await call('delete', `/holidays/${holiday.id}`);
      expect(res.body).toMatchObject({ restored: 0, generated: 1 });
      expect(await ctx.prisma.moduleSession.count({ where: { moduleId: id, deletedAt: null } })).toBe(8);
    });

    it.each([
      ['room', 'ROOM_BUSY'],
      ['teacher', 'TEACHER_BUSY'],
    ] as const)('does not give a session back when its %s is busy by now', async (who, reason) => {
      const { id, period, room, teacher } = await moduleOf();
      const holiday = (await call('post', '/holidays', { date: '2030-01-22', name: 'Festivo' })).body.holiday;
      // another module's session took the same hour (possible after a reschedule, spec 012)
      const other = await createModule(ctx.prisma, {
        periodId: period.id,
        roomId: who === 'room' ? room.id : undefined,
        teacherId: who === 'teacher' ? teacher.id : undefined,
        schedules: [{ dayOfWeek: 3, startMinute: 600, endMinute: 660 }],
      });
      await createSession(ctx.prisma, {
        moduleId: other.id,
        scheduleId: other.schedules[0]!.id,
        teacherId: who === 'teacher' ? teacher.id : other.teacherId,
        roomId: who === 'room' ? room.id : other.roomId,
        startsAt: new Date('2030-01-22T19:00:00Z'),
      });
      const res = await call('delete', `/holidays/${holiday.id}`);
      expect(res.body.restored).toBe(0);
      expect(res.body.notRestored).toEqual([{ sessionId: (await sessionOn(id, '2030-01-22')).id, moduleId: id, reason }]);
      expect((await sessionOn(id, '2030-01-22')).status).toBe('CANCELLED');
    });

    it('moves a holiday: the old day is given back and the new one is cancelled', async () => {
      const { id } = await moduleOf();
      const holiday = (await call('post', '/holidays', { date: '2030-01-22', name: 'Festivo' })).body.holiday;
      const res = await call('patch', `/holidays/${holiday.id}`, { date: '2030-01-29', name: 'Movido' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ holiday: { date: '2030-01-29', name: 'Movido' }, cancelledSessions: 1 });
      expect((await sessionOn(id, '2030-01-22')).status).toBe('SCHEDULED');
      expect((await sessionOn(id, '2030-01-29')).status).toBe('CANCELLED');
    });

    it('renames a holiday without touching sessions, and refuses a taken or past target date', async () => {
      const { id } = await moduleOf();
      const holiday = (await call('post', '/holidays', { date: '2030-01-22', name: 'Festivo' })).body.holiday;
      const renamed = await call('patch', `/holidays/${holiday.id}`, { date: '2030-01-22', name: 'Otro nombre' });
      expect(renamed.body).toMatchObject({ holiday: { name: 'Otro nombre' }, cancelledSessions: 0 });
      expect((await sessionOn(id, '2030-01-22')).status).toBe('CANCELLED');
      await call('post', '/holidays', { date: '2030-02-05', name: 'Ocupado' });
      expect((await call('patch', `/holidays/${holiday.id}`, { date: '2030-02-05', name: 'X' })).body.code).toBe('HOLIDAY_DATE_TAKEN');
      expect((await call('patch', `/holidays/${holiday.id}`, { date: '2020-01-01', name: 'X' })).body.code).toBe('HOLIDAY_IN_PAST');
    });
  });

  describe('import from the holidays service', () => {
    const entries = [
      { date: '2030-01-01', name: 'Año Nuevo' },
      { date: '2030-01-22', name: 'Festivo' },
      { date: '2030-03-25', name: 'San José' },
    ];

    it('previews the list and marks what already exists and what has passed, saving nothing', async () => {
      ctx.holidays.entries = [...entries, { date: '2020-01-01', name: 'Viejo' }];
      await createHoliday(ctx.prisma, { date: '2030-01-01' });
      const res = await call('get', '/holidays/import-preview?year=2030');
      expect(res.body.data).toEqual([
        { ...entries[0], alreadyExists: true, isPast: false },
        { ...entries[1], alreadyExists: false, isPast: false },
        { ...entries[2], alreadyExists: false, isPast: false },
      ]);
      expect((await call('get', '/holidays/import-preview?year=2020')).body.data[0]).toMatchObject({ isPast: true });
      expect(await ctx.prisma.holiday.count()).toBe(1);
      expect(ctx.holidays.requestedYears).toEqual([2030, 2020]);
    });

    it('imports the confirmed dates, skipping existing, past and unknown ones, and cancels their sessions', async () => {
      const { id } = await moduleOf();
      ctx.holidays.entries = entries;
      await createHoliday(ctx.prisma, { date: '2030-03-25' });
      const res = await call('post', '/holidays/import', { year: 2030, dates: ['2030-01-22', '2030-03-25', '2030-07-20'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ created: 1, skipped: 2, cancelledSessions: 1 });
      const saved = await ctx.prisma.holiday.findFirstOrThrow({ where: { date: new Date('2030-01-22T00:00:00Z') } });
      expect(saved).toMatchObject({ name: 'Festivo', source: 'IMPORTED' });
      expect((await sessionOn(id, '2030-01-22')).status).toBe('CANCELLED');
      // asking again does not duplicate
      expect((await call('post', '/holidays/import', { year: 2030, dates: ['2030-01-22'] })).body).toMatchObject({ created: 0, skipped: 1 });
      expect(await ctx.prisma.holiday.count()).toBe(2);
    });

    it('skips dates that have passed', async () => {
      ctx.holidays.entries = [{ date: '2020-01-01', name: 'Viejo' }];
      const res = await call('post', '/holidays/import', { year: 2020, dates: ['2020-01-01'] });
      expect(res.body).toMatchObject({ created: 0, skipped: 1 });
    });

    it('answers 502 and saves nothing when the service fails', async () => {
      ctx.holidays.mode = 'unavailable';
      for (const res of [await call('get', '/holidays/import-preview?year=2030'), await call('post', '/holidays/import', { year: 2030, dates: ['2030-01-01'] })]) {
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('HOLIDAYS_IMPORT_UNAVAILABLE');
      }
      expect(await ctx.prisma.holiday.count()).toBe(0);
      // the manual calendar keeps working
      expect((await call('post', '/holidays', { date: '2030-01-01', name: 'A mano' })).status).toBe(201);
    });

    it('validates the year and the dates', async () => {
      expect((await call('get', '/holidays/import-preview?year=abc')).status).toBe(400);
      expect((await call('post', '/holidays/import', { year: 2030, dates: [] })).status).toBe(400);
      expect((await call('post', '/holidays/import', { year: 2030, dates: ['hoy'] })).status).toBe(400);
    });
  });
});
