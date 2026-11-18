import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPeriod, createSession } from './utils/factories.js';
import { activePeriod, api, loginStudent, moduleWithSessions } from './utils/enrollment.js';
import { loadContract, specPath } from './utils/contract.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('011-student-enrollment/contracts/enrollments-api.yaml'));
const NOBODY = '00000000-0000-4000-8000-000000000999';

// Real answers of the seven endpoints against specs/011-student-enrollment/contracts.
describe.skipIf(!contract.available)('responses match enrollments-api.yaml', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const check = (res: { status: number; body: unknown }, method: string, path: string, schema: string) => {
    contract.assertDocumented(method, path, res.status);
    contract.assertMatchesSchema(schema, res.body);
    return res;
  };

  it('offer, detail, enroll, my enrollments and the cancellations', async () => {
    const period = await activePeriod(ctx);
    const { module, room, teacher, sessions } = await moduleWithSessions(ctx, period.id, { hoursAhead: [48, 216] });
    await createSession(ctx.prisma, {
      moduleId: module.id,
      scheduleId: module.schedules[0].id,
      teacherId: teacher.id,
      roomId: room.id,
      startsAt: new Date(Date.now() + 100 * 3_600_000),
      status: 'CANCELLED',
    });
    const student = api(ctx, await loginStudent(ctx));

    check(await student.offer(), 'get', '/student/modules', 'StudentModulePage');
    check(await student.detail(module.id), 'get', '/student/modules/{id}', 'StudentModuleDetail');
    const enrolled = check(await student.enroll(module.id), 'post', '/student/enrollments', 'Enrollment');
    const id = enrolled.body as { id: string };
    check(await student.enroll(module.id), 'post', '/student/enrollments', 'Error');
    check(await student.detail(module.id), 'get', '/student/modules/{id}', 'StudentModuleDetail');
    check(await student.mine('?status=ALL'), 'get', '/student/enrollments', 'EnrollmentPage');
    check(await student.mine('?status=NOPE'), 'get', '/student/enrollments', 'Error');
    const cancel = '/student/enrollments/{id}/sessions/{sessionId}/cancel';
    const restore = '/student/enrollments/{id}/sessions/{sessionId}/restore';
    check(await student.cancelSession(id.id, sessions[0].id), 'post', cancel, 'StudentSession');
    check(await student.restoreSession(id.id, sessions[0].id), 'post', restore, 'StudentSession');
    check(await student.cancelSession(id.id, NOBODY), 'post', cancel, 'Error');
    check(await student.restoreSession(NOBODY, sessions[0].id), 'post', restore, 'Error');
    check(await student.cancelModule(id.id), 'delete', '/student/enrollments/{id}', 'Enrollment');
    check(await student.cancelModule(id.id), 'delete', '/student/enrollments/{id}', 'Error');
    check(await student.cancelModule(NOBODY), 'delete', '/student/enrollments/{id}', 'Error');
    expect(true).toBe(true);
  });

  it('errors of a closed period, an unknown module and a missing detail follow the error schema', async () => {
    const closed = await createPeriod(ctx.prisma, { startsOn: '2020-01-01', endsOn: '2020-06-30', status: 'CLOSED' });
    const { module } = await moduleWithSessions(ctx, closed.id);
    const student = api(ctx, await loginStudent(ctx));
    check(await student.enroll(module.id), 'post', '/student/enrollments', 'Error');
    check(await student.enroll(NOBODY), 'post', '/student/enrollments', 'Error');
    check(await student.detail(NOBODY), 'get', '/student/modules/{id}', 'Error');
  });
});
