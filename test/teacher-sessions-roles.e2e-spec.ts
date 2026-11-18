import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { loadContract, specPath } from './utils/contract.js';
import { loginTeacher, teacherApi } from './utils/teacher.js';
import { seriesModule, start, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('012-teacher-sessions/contracts/teacher-sessions-api.yaml'));
const SOME_ID = '00000000-0000-4000-8000-000000000999';
const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

// Every endpoint of the contract is for teachers only. The list comes from the contract itself, so a
// new endpoint cannot slip in without being checked.
describe.skipIf(!contract.available)('teacher sessions: access by role', () => {
  let ctx: TestContext;
  const endpoints = Object.entries(contract.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .filter((method) => METHODS.includes(method))
      .map((method) => ({ method, url: path.replaceAll('{id}', SOME_ID) })),
  );

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const tokenOf = async (role: 'SUPERADMIN' | 'STUDENT') => {
    const user = await createUser(ctx.prisma, { role });
    const res = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  };
  const call = (method: string, url: string, token?: string) => {
    const req = ctx.http()[method as 'get'](`/api/v1${url}`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send({});
  };
  const rows = () => Promise.all([ctx.prisma.moduleSession.count(), ctx.prisma.outboxEvent.count()]);

  it('covers every endpoint of the contract', () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(5);
  });

  it.each(['STUDENT', 'SUPERADMIN'] as const)('answers 403 to a %s on every endpoint and changes nothing', async (role) => {
    const token = await tokenOf(role);
    const before = await rows();
    for (const { method, url } of endpoints) {
      const res = await call(method, url, token);
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
    expect(await rows()).toEqual(before);
  });

  it('answers 401 without a token on every endpoint', async () => {
    for (const { method, url } of endpoints) {
      expect((await call(method, url)).status, `${method} ${url}`).toBe(401);
    }
  });

  it('lets a teacher through on every endpoint (the answer is a business answer, never 401 or 403)', async () => {
    const teacher = await loginTeacher(ctx);
    for (const { method, url } of endpoints) {
      const { status } = await call(method, url, teacher.token);
      expect([401, 403], `${method} ${url}`).not.toContain(status);
    }
  });

  it('answers 404 and leaves the data alone when a teacher asks for another teacher\'s session', async () => {
    const p = await start(ctx);
    const owner = await seriesModule(ctx, p.id);
    const stranger = teacherApi(ctx, await loginTeacher(ctx));
    const id = owner.sessions[0][0].id;
    const startsAt = week(0, 19, 1).toISOString();
    expect((await stranger.reschedule(id, { scope: 'SESSION', startsAt })).status).toBe(404);
    expect((await stranger.cancel(id, { scope: 'SESSION' })).status).toBe(404);
    expect((await stranger.restore(id, { scope: 'SESSION' })).status).toBe(404);
    const row = await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SCHEDULED');
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
  });
});
