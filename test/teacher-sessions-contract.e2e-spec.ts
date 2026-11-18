import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { teacherApi } from './utils/teacher.js';
import { seriesModule, start, week } from './utils/teacher-fixture.js';
import { loadContract, specPath } from './utils/contract.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('012-teacher-sessions/contracts/teacher-sessions-api.yaml'));
const NOBODY = '00000000-0000-4000-8000-000000000999';

// Real answers of the five endpoints against specs/012-teacher-sessions/contracts.
describe.skipIf(!contract.available)('responses match teacher-sessions-api.yaml', () => {
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

  it('modules, sessions, reschedule, cancel and restore', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id);
    const api = teacherApi(ctx, m.teacher);
    const [s0, s1, s2] = m.sessions[0];
    const base = '/teacher/sessions/{id}';
    const wednesday = week(0, 19, 1).toISOString();

    check(await api.modules(), 'get', '/teacher/modules', 'TeacherModulePage');
    check(await api.sessions(), 'get', '/teacher/sessions', 'TeacherSessionPage');
    check(await api.sessions('?from=hoy'), 'get', '/teacher/sessions', 'Error');

    check(await api.reschedule(s0.id, { scope: 'SESSION', startsAt: wednesday }), 'post', `${base}/reschedule`, 'SessionChange');
    check(await api.reschedule(s0.id, { scope: 'SESSION', startsAt: wednesday, dryRun: true }), 'post', `${base}/reschedule`, 'SessionChange');
    check(await api.reschedule(s0.id, { scope: 'SESSION', startsAt: 'mañana' }), 'post', `${base}/reschedule`, 'Error');
    check(await api.reschedule(NOBODY, { scope: 'SESSION', startsAt: wednesday }), 'post', `${base}/reschedule`, 'Error');
    check(await api.reschedule(s1.id, { scope: 'SESSION', startsAt: new Date(s1.startsAt.getTime() + 7 * 86_400_000).toISOString() }), 'post', `${base}/reschedule`, 'Error');

    check(await api.cancel(s2.id, { scope: 'SESSION' }), 'post', `${base}/cancel`, 'SessionChange');
    check(await api.cancel(s2.id, { scope: 'SESSION' }), 'post', `${base}/cancel`, 'Error');
    check(await api.cancel(NOBODY, { scope: 'SESSION' }), 'post', `${base}/cancel`, 'Error');
    check(await api.cancel(s1.id, { scope: 'ALL' }), 'post', `${base}/cancel`, 'Error');

    check(await api.restore(s2.id, { scope: 'SESSION' }), 'post', `${base}/restore`, 'SessionChange');
    check(await api.restore(s2.id, { scope: 'SESSION' }), 'post', `${base}/restore`, 'Error');
    check(await api.restore(NOBODY, { scope: 'SESSION' }), 'post', `${base}/restore`, 'Error');
    expect(true).toBe(true);
  });

  it('an empty page and the errors of a closed period follow the schemas', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id);
    const api = teacherApi(ctx, m.teacher);
    await ctx.prisma.academicPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
    check(await api.modules(), 'get', '/teacher/modules', 'TeacherModulePage');
    check(await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }), 'post', '/teacher/sessions/{id}/cancel', 'Error');
    check(await api.sessions(), 'get', '/teacher/sessions', 'TeacherSessionPage');
  });
});
