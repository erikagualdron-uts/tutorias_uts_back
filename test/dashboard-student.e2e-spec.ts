import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAbsence, createEnrollment, createSession, createStudent } from './utils/factories.js';
import { signIn } from './utils/pqrs.js';
import { seriesModule, start, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// 2030-01-08 is a Tuesday: the series has one session per week at 14:00 Bogota.
describe('GET /dashboard/student (spec 019)', () => {
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
  const dashboard = (s: { get: (url: string) => PromiseLike<{ status: number; body: any }> }) => s.get('/dashboard/student');

  it('is empty for a student with no enrollments', async () => {
    const s = await student();
    const { status, body } = await dashboard(s);
    expect(status).toBe(200);
    expect(body).toEqual({ nextSession: null, weekSessions: 0, changes: [] });
  });

  it('shows the next session with its room and counts the week, without a teacher count', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3, name: 'Álgebra' });
    const s = await student();
    await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id });
    await seriesModule(ctx, p.id, { weeks: 3, name: 'Ajeno' }); // not enrolled: never shown

    const { body } = await dashboard(s);
    expect(body.nextSession).toMatchObject({ sessionId: m.sessions[0][0].id, moduleName: 'Álgebra', room: (await ctx.prisma.room.findUniqueOrThrow({ where: { id: m.room.id } })).name });
    expect(body.nextSession.attendees).toBeUndefined();
    expect(body.weekSessions).toBe(1);
  });

  it('skips a session the student gave up and a cancelled one', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3 });
    const s = await student();
    const enrollment = await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id });
    await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: m.sessions[0][0].id });

    let { body } = await dashboard(s);
    expect(body.nextSession.sessionId).toBe(m.sessions[0][1].id);
    expect(body.weekSessions).toBe(0);

    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][1].id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
    ({ body } = await dashboard(s));
    expect(body.nextSession.sessionId).toBe(m.sessions[0][2].id);
  });

  it('keeps sessions before the effective date of a cancelled enrollment and drops the later ones', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3 });
    const s = await student();
    await createEnrollment(ctx.prisma, {
      studentId: s.user.id,
      moduleId: m.module.id,
      status: 'CANCELLED',
      effectiveUntil: new Date('2030-01-09T00:00:00Z'), // after the first session, before the second
    });

    expect((await dashboard(s)).body.nextSession.sessionId).toBe(m.sessions[0][0].id);
    ctx.clock.freezeAt(new Date('2030-01-09T12:00:00Z'));
    expect((await dashboard(s)).body.nextSession).toBeNull();
  });

  it('lists up to 5 recent changes of enrolled modules only, without holiday cancellations', async () => {
    const p = await start(ctx);
    const mine = await seriesModule(ctx, p.id, { weeks: 8, name: 'Mío' });
    const other = await seriesModule(ctx, p.id, { weeks: 2, name: 'Ajeno' });
    const s = await student();
    await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: mine.module.id });
    for (let n = 0; n < 6; n++) {
      await ctx.prisma.moduleSession.update({ where: { id: mine.sessions[0][n].id }, data: { status: 'RESCHEDULED' } });
    }
    await ctx.prisma.moduleSession.update({ where: { id: mine.sessions[0][6].id }, data: { status: 'CANCELLED', cancelReason: 'HOLIDAY' } });
    await ctx.prisma.moduleSession.update({ where: { id: other.sessions[0][0].id }, data: { status: 'RESCHEDULED' } });

    const { body } = await dashboard(s);
    expect(body.changes).toHaveLength(5);
    expect(body.changes.every((c: { moduleName: string; kind: string }) => c.moduleName === 'Mío' && c.kind === 'RESCHEDULED')).toBe(true);
  });

  it('does not list a change of a module the student left', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 2 });
    const s = await student();
    await createEnrollment(ctx.prisma, { studentId: s.user.id, moduleId: m.module.id, status: 'CANCELLED' });
    await createSession(ctx.prisma, { moduleId: m.module.id, scheduleId: m.module.schedules[0].id, teacherId: m.teacher.user.id, roomId: m.room.id, startsAt: week(5), status: 'RESCHEDULED' });

    expect((await dashboard(s)).body.changes).toEqual([]);
  });
});
