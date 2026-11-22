import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCaller, studentCaller, teacherCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const ROUTES = [
  ['/dashboard/admin/overview', 'admin'],
  ['/dashboard/admin/changes', 'admin'],
  ['/dashboard/admin/rooms', 'admin'],
  ['/dashboard/teacher', 'teacher'],
  ['/dashboard/student', 'student'],
] as const;
type RoleName = (typeof ROUTES)[number][1];

describe('Dashboard routes are role-bound (spec 019)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const callers = async () => ({
    admin: await adminCaller(ctx),
    teacher: await teacherCaller(ctx),
    student: await studentCaller(ctx),
  });

  it.each(ROUTES)('GET %s answers 401 without a session', async (path) => {
    expect((await ctx.http().get(`/api/v1${path}`)).status).toBe(401);
  });

  it.each(ROUTES)('GET %s answers 200 to its role and 403 to the others', async (path, role) => {
    const all = await callers();
    for (const name of Object.keys(all) as RoleName[]) {
      const res = await all[name].get(path);
      expect(res.status, `${name} on ${path}`).toBe(name === role ? 200 : 403);
    }
  });

  it('GET /dashboard/admin/changes rejects a limit outside 1 to 50', async () => {
    const { admin } = await callers();
    expect((await admin.get('/dashboard/admin/changes?limit=51')).status).toBe(400);
    expect((await admin.get('/dashboard/admin/changes?limit=0')).status).toBe(400);
    expect((await admin.get('/dashboard/admin/changes?limit=50')).status).toBe(200);
  });
});
