import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from './utils/factories.js';
import { loginTeacher, teacherApi } from './utils/teacher.js';
import { enrollStudents, seriesModule, start, THU } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

interface Item {
  id: string;
  startsAt: string;
  status: string;
  attendees: number;
  canReschedule: boolean;
  blockReason: string | null;
}

const WEEK_0 = '?from=2030-01-07&to=2030-01-13';
const WEEK_1 = '?from=2030-01-14&to=2030-01-20';

describe('GET /teacher/calendar', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  it('returns the sessions of the range, past and future, in order and only the range', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 4 });
    await enrollStudents(ctx, m.module.id, 2);
    ctx.clock.freezeAt(new Date('2030-01-09T12:00:00Z')); // Wednesday: the Tuesday session is past
    const api = teacherApi(ctx, m.teacher);

    const past = (await api.calendar(WEEK_0)).body.data as Item[];
    expect(past.map((s) => s.id)).toEqual([m.sessions[0][0].id]);
    expect(past[0]).toMatchObject({ attendees: 2, canReschedule: false, blockReason: 'PAST' });

    const future = (await api.calendar(WEEK_1)).body.data as Item[];
    expect(future.map((s) => s.id)).toEqual([m.sessions[0][1].id]);
    expect(future[0]).toMatchObject({ attendees: 2, canReschedule: true, blockReason: null });
  });

  it('keeps cancelled sessions with their state', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 2 });
    await ctx.prisma.moduleSession.update({
      where: { id: m.sessions[0][0].id },
      data: { status: 'CANCELLED', cancelReason: 'TEACHER' },
    });
    const body = (await teacherApi(ctx, m.teacher).calendar(WEEK_0)).body;
    expect(body.data[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'TEACHER', attendees: 0, canRestore: true });
  });

  it('shows only the sessions of the teacher in the token and skips deleted ones', async () => {
    const p = await start(ctx);
    const mine = await seriesModule(ctx, p.id, { weeks: 1 });
    await seriesModule(ctx, p.id, { weeks: 1, name: 'De otro' });
    const gone = await seriesModule(ctx, p.id, { weeks: 0, teacherId: mine.teacher.user.id, slots: [THU] });
    await createSession(ctx.prisma, {
      moduleId: gone.module.id,
      scheduleId: gone.module.schedules[0].id,
      teacherId: mine.teacher.user.id,
      roomId: gone.room.id,
      startsAt: new Date('2030-01-10T19:00:00Z'),
      deletedAt: new Date(),
    });
    const body = (await teacherApi(ctx, mine.teacher).calendar(WEEK_0)).body;
    expect(body.data.map((s: Item) => s.id)).toEqual([mine.sessions[0][0].id]);
  });

  it('places a session by its Bogota day, never by its UTC day', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 0 });
    // 22:30 Tuesday in Bogota is already Wednesday in UTC.
    await createSession(ctx.prisma, {
      moduleId: m.module.id,
      scheduleId: m.module.schedules[0].id,
      teacherId: m.teacher.user.id,
      roomId: m.room.id,
      startsAt: new Date('2030-01-09T03:30:00Z'),
    });
    const api = teacherApi(ctx, m.teacher);
    expect((await api.calendar('?from=2030-01-08&to=2030-01-08')).body.data).toHaveLength(1);
    expect((await api.calendar('?from=2030-01-09&to=2030-01-09')).body.data).toHaveLength(0);
  });

  it('describes the active period, the allowed hours and the change limit', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1 });
    const { meta } = (await teacherApi(ctx, m.teacher).calendar(WEEK_0)).body;
    expect(meta).toEqual({
      from: '2030-01-07',
      to: '2030-01-13',
      period: { id: p.id, name: p.name, startsOn: '2030-01-07', endsOn: '2030-03-03', status: 'ACTIVE' },
      hours: { earliest: '06:00', latest: '18:00' },
      changeLeadMinutes: 120,
    });
  });

  it('falls back to the last closed period, read only', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1 });
    await ctx.prisma.academicPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
    const body = (await teacherApi(ctx, m.teacher).calendar(WEEK_0)).body;
    expect(body.meta.period).toMatchObject({ id: p.id, status: 'CLOSED' });
    expect(body.data[0]).toMatchObject({ canReschedule: false, canCancel: false, blockReason: 'PERIOD_CLOSED' });
  });

  it('answers an empty list and a null period when the teacher has no period', async () => {
    const teacher = await loginTeacher(ctx);
    const body = (await teacherApi(ctx, teacher).calendar(WEEK_0)).body;
    expect(body.data).toEqual([]);
    expect(body.meta.period).toBeNull();
  });

  it.each([
    ['', 'no days'],
    ['?from=2030-01-07', 'no to'],
    ['?to=2030-01-13', 'no from'],
    ['?from=hoy&to=2030-01-13', 'not a day'],
    ['?from=2030-02-30&to=2030-03-02', 'not a real day'],
    ['?from=2030-01-13&to=2030-01-07', 'reversed'],
    ['?from=2030-01-07&to=2030-01-14', 'eight days'],
  ])('rejects %s (%s) with VALIDATION_FAILED', async (query) => {
    const teacher = await loginTeacher(ctx);
    const res = await teacherApi(ctx, teacher).calendar(query);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
