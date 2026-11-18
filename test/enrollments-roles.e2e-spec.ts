import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnrollment, createUser, TEST_PASSWORD } from './utils/factories.js';
import { activePeriod, api, loginStudent, moduleWithSessions } from './utils/enrollment.js';
import { loadContract, specPath } from './utils/contract.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('011-student-enrollment/contracts/enrollments-api.yaml'));
const SOME_ID = '00000000-0000-4000-8000-000000000999';
const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

// SC-007: every endpoint of the contract is for students only. The list comes from the contract
// itself, so a new endpoint cannot slip in without being checked.
describe.skipIf(!contract.available)('student enrollment: access by role', () => {
  let ctx: TestContext;
  const endpoints = Object.entries(contract.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .filter((method) => METHODS.includes(method))
      .map((method) => ({
        method,
        url: path.replaceAll('{id}', SOME_ID).replaceAll('{sessionId}', SOME_ID),
      })),
  );

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const tokenOf = async (role: 'SUPERADMIN' | 'TEACHER') => {
    const user = await createUser(ctx.prisma, { role });
    const res = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  };
  const call = (method: string, url: string, token?: string) => {
    const req = ctx.http()[method as 'get'](`/api/v1${url}`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send({});
  };
  const rows = () => Promise.all([ctx.prisma.enrollment.count(), ctx.prisma.sessionAbsence.count()]);

  it('covers every endpoint of the contract', () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(7);
  });

  it.each(['TEACHER', 'SUPERADMIN'] as const)('answers 403 to a %s on every endpoint and changes nothing', async (role) => {
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

  it('lets a student through on every endpoint (the answer is a business answer, never 401 or 403)', async () => {
    const student = await loginStudent(ctx);
    for (const { method, url } of endpoints) {
      const { status } = await call(method, url, student.token);
      expect([401, 403], `${method} ${url}`).not.toContain(status);
    }
  });

  it('answers 404 and leaves the data alone when a student asks for another student\'s enrollment', async () => {
    const period = await activePeriod(ctx);
    const { module, sessions } = await moduleWithSessions(ctx, period.id);
    const owner = await loginStudent(ctx);
    const enrollment = await createEnrollment(ctx.prisma, { studentId: owner.user.id, moduleId: module.id });
    const stranger = api(ctx, await loginStudent(ctx));
    expect((await stranger.cancelModule(enrollment.id)).status).toBe(404);
    expect((await stranger.cancelSession(enrollment.id, sessions[0].id)).status).toBe(404);
    expect((await stranger.restoreSession(enrollment.id, sessions[0].id)).status).toBe(404);
    expect((await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status).toBe('ACTIVE');
    expect(await ctx.prisma.sessionAbsence.count()).toBe(0);
  });
});
