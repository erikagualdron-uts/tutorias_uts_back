import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginTeacher, teacherApi } from './utils/teacher.js';
import { enrollStudents, seriesModule, start } from './utils/teacher-fixture.js';
import { loadContract, specPath } from './utils/contract.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('013-teacher-weekly-calendar/contracts/teacher-calendar-api.yaml'));

// Real answers of the calendar endpoint against specs/013-teacher-weekly-calendar/contracts.
describe.skipIf(!contract.available)('responses match teacher-calendar-api.yaml', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const check = (res: { status: number; body: unknown }, schema: string) => {
    contract.assertDocumented('get', '/teacher/calendar', res.status);
    contract.assertMatchesSchema(schema, res.body);
    return res;
  };

  it('weeks with sessions of every state, a teacher without period and the errors', async () => {
    check(await teacherApi(ctx, await loginTeacher(ctx)).calendar('?from=2030-01-07&to=2030-01-13'), 'CalendarResponse');

    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 3 });
    await enrollStudents(ctx, m.module.id, 1);
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][1].id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][2].id }, data: { status: 'CANCELLED', cancelReason: 'HOLIDAY' } });
    const api = teacherApi(ctx, m.teacher);
    for (const query of ['?from=2030-01-07&to=2030-01-13', '?from=2030-01-14&to=2030-01-20', '?from=2030-01-21&to=2030-01-27']) {
      const res = check(await api.calendar(query), 'CalendarResponse');
      expect((res.body as { data: unknown[] }).data).toHaveLength(1);
    }
    check(await api.calendar('?from=hoy&to=2030-01-13'), 'Error');
    check(await api.calendar('?from=2030-01-07&to=2030-01-14'), 'Error');

    await ctx.prisma.academicPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
    check(await api.calendar('?from=2030-01-07&to=2030-01-13'), 'CalendarResponse');
  });
});
