import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAbsence, createModule } from './utils/factories.js';
import { loginTeacher } from './utils/teacher.js';
import { enrollStudents, seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// 2030-01-08 is a Tuesday: the series has one session per week at 14:00 Bogota.
describe('GET /dashboard/teacher (spec 019)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const dashboard = (token: string) => ctx.http().get('/api/v1/dashboard/teacher').set('Authorization', `Bearer ${token}`);

  it('is empty for a teacher with no modules', async () => {
    const teacher = await loginTeacher(ctx);
    const { status, body } = await dashboard(teacher.token);
    expect(status).toBe(200);
    expect(body).toEqual({ nextSession: null, weekSessions: 0, modules: [] });
  });

  it('shows the next session with room and attendees, the week and the seats of each module', async () => {
    const p = await start(ctx); // Monday 07:00 Bogota
    const m = await seriesModule(ctx, p.id, { weeks: 3, name: 'Cálculo', capacity: 30 });
    await enrollStudents(ctx, m.module.id, 3);

    const { body } = await dashboard(m.teacher.token);
    expect(body.nextSession).toMatchObject({
      sessionId: m.sessions[0][0].id,
      moduleId: m.module.id,
      moduleName: 'Cálculo',
      room: (await ctx.prisma.room.findUniqueOrThrow({ where: { id: m.room.id } })).name,
      attendees: 3,
    });
    expect(body.weekSessions).toBe(1);
    expect(body.modules).toEqual([{ id: m.module.id, name: 'Cálculo', enrolled: 3, capacity: 30 }]);
  });

  it('does not count a student who skipped the next session', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 2 });
    const [first] = await enrollStudents(ctx, m.module.id, 2);
    await createAbsence(ctx.prisma, { enrollmentId: first.enrollment.id, sessionId: m.sessions[0][0].id });

    expect((await dashboard(m.teacher.token)).body.nextSession.attendees).toBe(1);
  });

  it('moves to the next session when the next one is cancelled and leaves it out of the week', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3 });
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][0].id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });

    const { body } = await dashboard(m.teacher.token);
    expect(body.nextSession.sessionId).toBe(m.sessions[0][1].id);
    expect(body.weekSessions).toBe(0);
  });

  it('counts the week Monday to Sunday in Bogota time, past sessions included', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1 }); // only Tuesday 2030-01-08
    ctx.clock.freezeAt(new Date('2030-01-14T04:30:00Z')); // Sunday 23:30 Bogota: still that week, the session is past
    let { body } = await dashboard(m.teacher.token);
    expect(body.weekSessions).toBe(1);
    expect(body.nextSession).toBeNull();

    ctx.clock.freezeAt(new Date('2030-01-14T05:10:00Z')); // Monday 00:10 Bogota: a new week
    ({ body } = await dashboard(m.teacher.token));
    expect(body.weekSessions).toBe(0);
  });

  it('never shows another teacher, a deleted module or a module of another period', async () => {
    const p = await start(ctx);
    const mine = await seriesModule(ctx, p.id, { weeks: 2, name: 'Mío' });
    await seriesModule(ctx, p.id, { weeks: 2, name: 'Ajeno' });
    await createModule(ctx.prisma, { periodId: p.id, teacherId: mine.teacher.user.id, name: 'Borrado', deletedAt: new Date(), schedules: [{ dayOfWeek: 5, startMinute: 600, endMinute: 660 }] });

    const { body } = await dashboard(mine.teacher.token);
    expect(body.modules.map((x: { name: string }) => x.name)).toEqual(['Mío']);
    expect(body.weekSessions).toBe(1);
  });
});
