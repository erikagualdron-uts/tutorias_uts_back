import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadContract, specPath } from './utils/contract.js';
import { createAbsence, createEnrollment, createStudent } from './utils/factories.js';
import { adminCaller, signIn, teacherCaller } from './utils/pqrs.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('021-student-schedule/contracts/student-calendar-api.yaml'));
const WEEK = '?from=2030-01-07&to=2030-01-13';

// Real answers of the endpoint against specs/021-student-schedule/contracts/student-calendar-api.yaml.
describe.skipIf(!contract.available)('responses match student-calendar-api.yaml', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const check = <T extends { status: number; body: unknown }>(res: T, schema: string): T => {
    contract.assertDocumented('get', '/student/calendar', res.status);
    contract.assertMatchesSchema(schema, res.body);
    return res;
  };

  it('a week with sessions of every state, an empty week, no period and the errors', async () => {
    const lonely = await createStudent(ctx.prisma);
    check(await (await signIn(ctx, lonely)).get(`/student/calendar${WEEK}`), 'StudentCalendar'); // no period at all

    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3 });
    const student = await createStudent(ctx.prisma);
    const enrollment = await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
    await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: m.sessions[0][0].id });
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][1].id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][2].id }, data: { status: 'CANCELLED', cancelReason: 'HOLIDAY' } });
    const me = await signIn(ctx, student);
    for (const query of [WEEK, '?from=2030-01-14&to=2030-01-20', '?from=2030-01-21&to=2030-01-27']) {
      const res = check(await me.get(`/student/calendar${query}`), 'StudentCalendar');
      expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    }
    check(await me.get('/student/calendar?from=2030-03-04&to=2030-03-10'), 'StudentCalendar'); // a week after the period
    check(await (await signIn(ctx, await createStudent(ctx.prisma))).get(`/student/calendar${WEEK}`), 'StudentCalendar'); // no enrollments

    check(await me.get('/student/calendar?from=hoy&to=2030-01-13'), 'Error');
    check(await me.get('/student/calendar?from=2030-01-07&to=2030-01-14'), 'Error');
    check(await ctx.http().get(`/api/v1/student/calendar${WEEK}`), 'Error');
    check(await (await teacherCaller(ctx)).get(`/student/calendar${WEEK}`), 'Error');
    check(await (await adminCaller(ctx)).get(`/student/calendar${WEEK}`), 'Error');
    expect(contract.available).toBe(true);
  });
});
