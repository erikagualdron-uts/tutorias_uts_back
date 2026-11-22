import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStudent } from './utils/factories.js';
import { adminCaller, signIn, studentCaller, teacherCaller } from './utils/pqrs.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const WEEK = '?from=2030-01-07&to=2030-01-13';

describe('GET /student/calendar is for students only (spec 021)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('answers 401 without a session', async () => {
    expect((await ctx.http().get(`/api/v1/student/calendar${WEEK}`)).status).toBe(401);
  });

  it('answers 403 to a teacher and to the CAE, and 200 to a student', async () => {
    const [teacher, cae, student] = [await teacherCaller(ctx), await adminCaller(ctx), await studentCaller(ctx)];
    expect((await teacher.get(`/student/calendar${WEEK}`)).status).toBe(403);
    expect((await cae.get(`/student/calendar${WEEK}`)).status).toBe(403);
    expect((await student.get(`/student/calendar${WEEK}`)).status).toBe(200);
  });

  it.each([
    ['without from', '?to=2030-01-13'],
    ['without to', '?from=2030-01-07'],
    ['with an invalid day', '?from=2030-02-30&to=2030-03-02'],
    ['with a malformed day', '?from=hoy&to=2030-01-13'],
    ['with to before from', '?from=2030-01-13&to=2030-01-07'],
    ['with more than 7 days', '?from=2030-01-07&to=2030-01-14'],
  ])('answers 400 VALIDATION_FAILED %s', async (_name, query) => {
    const student = await studentCaller(ctx);
    const res = await student.get(`/student/calendar${query}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('never gives a student the sessions of another, even in the same module', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 1 });
    const [ana, luis] = [await createStudent(ctx.prisma), await createStudent(ctx.prisma)];
    const enrollment = await ctx.prisma.enrollment.create({ data: { studentId: ana.id, moduleId: m.module.id } });
    await ctx.prisma.sessionAbsence.create({ data: { enrollmentId: enrollment.id, sessionId: m.sessions[0][0].id } });
    const [anaCaller, luisCaller] = [await signIn(ctx, ana), await signIn(ctx, luis)];

    const mine = (await anaCaller.get(`/student/calendar${WEEK}`)).body;
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0].absent).toBe(true);
    const theirs = (await luisCaller.get(`/student/calendar${WEEK}`)).body;
    expect(theirs.data).toEqual([]);
    expect(theirs.meta.hasEnrollments).toBe(false);
  });
});
