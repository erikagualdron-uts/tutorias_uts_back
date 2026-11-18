import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnrollment } from './utils/factories.js';
import { api as studentApi, loginStudent } from './utils/enrollment.js';
import { loginTeacher, teacherApi } from './utils/teacher.js';
import { seriesModule, start, THU, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// Nothing ends up in the same room or with the same teacher at one hour, even when the requests
// arrive together: the rooms and teachers of the sessions that move are locked in a fixed order.
describe('teacher sessions: concurrency', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const wednesday = () => week(0, 19, 1).toISOString();
  const codes = (results: { status: number; body: { code?: string } }[]) =>
    results.map((r) => (r.status === 200 ? 200 : r.body.code));

  it('lets one of two teachers take the same room at the same hour', async () => {
    for (let round = 0; round < 4; round++) {
      await ctx.reset();
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id, { weeks: 1 });
      const b = await seriesModule(ctx, p.id, { roomId: a.room.id, slots: [THU], weeks: 1 });
      const results = await Promise.all([
        teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday() }),
        teacherApi(ctx, b.teacher).reschedule(b.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday() }),
      ]);
      expect(codes(results).sort(), `round ${round}`).toEqual([200, 'MODULE_ROOM_CONFLICT']);
      const taken = await ctx.prisma.moduleSession.count({ where: { roomId: a.room.id, startsAt: new Date(wednesday()) } });
      expect(taken).toBe(1);
    }
  });

  it('lets one of two sessions of the same teacher take the same hour', async () => {
    const p = await start(ctx);
    const a = await seriesModule(ctx, p.id, { weeks: 1 });
    const c = await seriesModule(ctx, p.id, { teacherId: a.teacher.user.id, slots: [THU], weeks: 1 });
    const api = teacherApi(ctx, a.teacher);
    const results = await Promise.all([
      api.reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday() }),
      api.reschedule(c.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday() }),
    ]);
    expect(codes(results).sort()).toEqual([200, 'MODULE_TEACHER_CONFLICT']);
  });

  it('keeps the attendees within the capacity when a reschedule and an enrollment arrive together', async () => {
    const p = await start(ctx);
    const a = await seriesModule(ctx, p.id, { capacity: 1, weeks: 1 });
    const first = await loginStudent(ctx);
    await createEnrollment(ctx.prisma, { studentId: first.user.id, moduleId: a.module.id });
    const second = await loginStudent(ctx);
    const [moved, enrolled] = await Promise.all([
      teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday() }),
      studentApi(ctx, second).enroll(a.module.id),
    ]);
    expect(moved.status).toBe(200);
    expect(enrolled.status).toBe(409);
    expect(enrolled.body.code).toBe('ENROLLMENT_MODULE_FULL');
    expect(await ctx.prisma.enrollment.count({ where: { moduleId: a.module.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('keeps the helpers honest', async () => {
    expect((await loginTeacher(ctx)).token).toBeTruthy();
  });
});
