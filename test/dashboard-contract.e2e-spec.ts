import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadContract, specPath } from './utils/contract.js';
import { createEnrollment, createPqrs, createStudent } from './utils/factories.js';
import { adminCaller, signIn } from './utils/pqrs.js';
import { enrollStudents, seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('019-dashboards/contracts/dashboard-api.yaml'));

// Real answers of the 5 endpoints against specs/019-dashboards/contracts/dashboard-api.yaml.
describe.skipIf(!contract.available)('responses match dashboard-api.yaml', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const check = <T extends { status: number; body: unknown }>(res: T, path: string, schema: string): T => {
    contract.assertDocumented('get', path, res.status);
    contract.assertMatchesSchema(schema, res.body);
    return res;
  };

  it('the CAE side, with data and without it', async () => {
    const p = await start(ctx); // moves the clock to 2030: sign in after it
    const cae = await adminCaller(ctx);
    check(await cae.get('/dashboard/admin/overview'), '/dashboard/admin/overview', 'AdminOverview');
    check(await cae.get('/dashboard/admin/changes'), '/dashboard/admin/changes', 'RecentChangePage');
    check(await cae.get('/dashboard/admin/rooms'), '/dashboard/admin/rooms', 'AdminRooms');

    const m = await seriesModule(ctx, p.id, { weeks: 2 });
    await enrollStudents(ctx, m.module.id, 2);
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][0].id }, data: { status: 'RESCHEDULED' } });
    const author = await createStudent(ctx.prisma);
    await createPqrs(ctx.prisma, { authorId: author.id, status: 'RESOLVED' });

    const overview = check(await cae.get('/dashboard/admin/overview'), '/dashboard/admin/overview', 'AdminOverview');
    expect(overview.body.modules.active).toBe(1);
    expect(check(await cae.get('/dashboard/admin/changes'), '/dashboard/admin/changes', 'RecentChangePage').body.data).toHaveLength(1);
    expect(check(await cae.get('/dashboard/admin/rooms'), '/dashboard/admin/rooms', 'AdminRooms').body.most).toHaveLength(1);
    check(await cae.get('/dashboard/admin/changes?limit=51'), '/dashboard/admin/changes', 'Error');
  });

  it('the teacher and the student sides, with a session and without one', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id, { weeks: 2 });
    const [{ student }] = await enrollStudents(ctx, m.module.id, 1);
    const teacher = { token: m.teacher.token, get: (url: string) => ctx.http().get(`/api/v1${url}`).set('Authorization', `Bearer ${m.teacher.token}`) };
    const enrolled = await signIn(ctx, student);
    const loner = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, { studentId: loner.id, moduleId: m.module.id, status: 'CANCELLED' });
    const idle = await signIn(ctx, loner);

    expect(check(await teacher.get('/dashboard/teacher'), '/dashboard/teacher', 'TeacherDashboard').body.nextSession).not.toBeNull();
    expect(check(await enrolled.get('/dashboard/student'), '/dashboard/student', 'StudentDashboard').body.nextSession).not.toBeNull();
    expect(check(await idle.get('/dashboard/student'), '/dashboard/student', 'StudentDashboard').body.nextSession).toBeNull();
    check(await enrolled.get('/dashboard/teacher'), '/dashboard/teacher', 'Error');
    check(await teacher.get('/dashboard/student'), '/dashboard/student', 'Error');
  });
});
