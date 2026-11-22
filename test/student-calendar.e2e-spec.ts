import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAbsence, createEnrollment, createPeriod, createStudent } from './utils/factories.js';
import { signIn } from './utils/pqrs.js';
import { seriesModule, start, TUE, THU } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const WEEK_0 = '?from=2030-01-07&to=2030-01-13'; // Tuesday 2030-01-08 and Thursday 2030-01-10
const WEEK_1 = '?from=2030-01-14&to=2030-01-20';
type Caller = Awaited<ReturnType<typeof signIn>>;

describe('GET /student/calendar (spec 021)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  async function student() {
    const user = await createStudent(ctx.prisma);
    return { user, ...(await signIn(ctx, user)) };
  }
  const calendar = (s: Caller, week = WEEK_0) => s.get(`/student/calendar${week}`);
  const ids = (body: { data: { id: string }[] }) => body.data.map((x) => x.id);

  it('gives the sessions of the modules where the student is enrolled, by hour, with module, teacher and room', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3, name: 'Álgebra', slots: [TUE, THU] });
    const other = await seriesModule(ctx, p.id, { weeks: 3, name: 'Ajeno' });
    await ctx.prisma.moduleSession.update({ where: { id: other.sessions[0][0].id }, data: { deletedAt: new Date() } });
    const s = await student();
    await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id });

    const { status, body } = await calendar(s);
    expect(status).toBe(200);
    expect(ids(body)).toEqual([m.sessions[0][0].id, m.sessions[1][0].id]);
    const profile = await ctx.prisma.teacherProfile.findFirstOrThrow({ where: { userId: m.teacher.user.id } });
    const room = await ctx.prisma.room.findUniqueOrThrow({ where: { id: m.room.id }, include: { location: true } });
    expect(body.data[0]).toMatchObject({
      moduleId: m.module.id,
      moduleName: 'Álgebra',
      teacherName: `${profile.firstName} ${profile.lastName}`,
      room: { id: room.id, name: room.name, location: room.location.name, capacity: room.capacity },
      startsAt: '2030-01-08T19:00:00.000Z',
      endsAt: '2030-01-08T21:00:00.000Z',
      originalStartsAt: '2030-01-08T19:00:00.000Z',
      status: 'SCHEDULED',
      cancelReason: null,
      absent: false,
    });
    expect(body.meta.hasEnrollments).toBe(true);
  });

  it('gives only the sessions of the asked week, past and future, and never those of a deleted module', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3 });
    const gone = await seriesModule(ctx, p.id, { weeks: 3, name: 'Borrado' });
    await ctx.prisma.module.update({ where: { id: gone.module.id }, data: { deletedAt: new Date() } });
    const s = await student();
    for (const x of [m, gone]) await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: x.module.id });
    ctx.clock.freezeAt(new Date('2030-01-16T12:00:00Z')); // the first Tuesday is past

    expect(ids((await calendar(s, WEEK_0)).body)).toEqual([m.sessions[0][0].id]);
    expect(ids((await calendar(s, WEEK_1)).body)).toEqual([m.sessions[0][1].id]);
  });

  it('answers the period, the allowed hours and, without enrollments, no sessions and hasEnrollments false', async () => {
    const p = await start(ctx);
    await seriesModule(ctx, p.id, { weeks: 1 });
    const s = await student();
    const { body } = await calendar(s);
    expect(body.data).toEqual([]);
    expect(body.meta).toMatchObject({
      from: '2030-01-07',
      to: '2030-01-13',
      period: { id: p.id, startsOn: '2030-01-07', endsOn: '2030-03-03', status: 'ACTIVE' },
      hours: { earliest: expect.stringMatching(/^\d\d:\d\d$/), latest: expect.stringMatching(/^\d\d:\d\d$/) },
      hasEnrollments: false,
    });
  });

  it('shows a rescheduled session at its new hour with the original one, and a cancelled one with its reason', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1, slots: [TUE, THU] });
    const s = await student();
    await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id });
    const moved = new Date('2030-01-09T15:00:00Z');
    await ctx.prisma.moduleSession.update({
      where: { id: m.sessions[0][0].id },
      data: { status: 'RESCHEDULED', startsAt: moved, endsAt: new Date(moved.getTime() + 2 * 3_600_000) },
    });
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[1][0].id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });

    const [first, second] = (await calendar(s)).body.data;
    expect(first).toMatchObject({ status: 'RESCHEDULED', startsAt: moved.toISOString(), originalStartsAt: '2030-01-08T19:00:00.000Z', cancelReason: null });
    expect(second).toMatchObject({ status: 'CANCELLED', cancelReason: 'TEACHER' });
  });

  it('shows a holiday cancellation with its reason', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1 });
    const s = await student();
    await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id });
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][0].id }, data: { status: 'CANCELLED', cancelReason: 'HOLIDAY' } });
    expect((await calendar(s)).body.data[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'HOLIDAY' });
  });

  it('keeps the session the student skipped, marked absent; a deleted absence does not count', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1, slots: [TUE, THU] });
    const s = await student();
    const enrollment = await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id });
    await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: m.sessions[0][0].id });
    await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: m.sessions[1][0].id, deletedAt: new Date() });

    const [first, second] = (await calendar(s)).body.data;
    expect(first.absent).toBe(true);
    expect(second.absent).toBe(false);
  });

  it('covers only the sessions before the effective date of a cancelled enrollment', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1, slots: [TUE, THU] });
    const s = await student();
    await createEnrollment(ctx.prisma, {
      studentId: s.user.id,
      moduleId: m.module.id,
      status: 'CANCELLED',
      effectiveUntil: new Date('2030-01-09T00:00:00Z'), // after Tuesday, before Thursday
    });
    const { body } = await calendar(s);
    expect(ids(body)).toEqual([m.sessions[0][0].id]);
    expect(body.meta.hasEnrollments).toBe(true);
  });

  it('shows a change of the session in the next request without signing in again', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1 });
    const s = await student();
    await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id });
    expect((await calendar(s)).body.data[0].status).toBe('SCHEDULED');
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][0].id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
    expect((await calendar(s)).body.data[0].status).toBe('CANCELLED');
  });

  it('uses the active period, or the last closed one when there is no active period, or none', async () => {
    const none = await student();
    expect((await calendar(none)).body.meta.period).toBeNull();
    const closed = await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2029-01-01', endsOn: '2029-06-30' });
    expect((await calendar(none)).body.meta.period).toMatchObject({ id: closed.id, status: 'CLOSED' });
    const p = await start(ctx);
    const after = await student();
    expect((await calendar(after)).body.meta.period).toMatchObject({ id: p.id, status: 'ACTIVE' });
  });
});
