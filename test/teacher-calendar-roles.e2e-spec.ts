import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { loadContract, specPath } from './utils/contract.js';
import { loginTeacher } from './utils/teacher.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('013-teacher-weekly-calendar/contracts/teacher-calendar-api.yaml'));
const METHODS = ['get', 'post', 'patch', 'put', 'delete'];

// Every endpoint of the contract is for teachers only. The list comes from the contract itself, so a
// new endpoint cannot slip in without being checked.
describe.skipIf(!contract.available)('teacher calendar: access by role', () => {
  let ctx: TestContext;
  const endpoints = Object.entries(contract.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .filter((method) => METHODS.includes(method))
      .map((method) => ({ method, url: `${path}?from=2030-01-07&to=2030-01-13` })),
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
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('covers every endpoint of the contract', () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
  });

  it.each(['STUDENT', 'SUPERADMIN'] as const)('answers 403 to a %s on every endpoint', async (role) => {
    const token = await tokenOf(role);
    for (const { method, url } of endpoints) {
      const res = await call(method, url, token);
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('answers 401 without a token on every endpoint', async () => {
    for (const { method, url } of endpoints) {
      expect((await call(method, url)).status, `${method} ${url}`).toBe(401);
    }
  });

  it('lets a teacher through on every endpoint', async () => {
    const teacher = await loginTeacher(ctx);
    for (const { method, url } of endpoints) {
      const { status } = await call(method, url, teacher.token);
      expect([401, 403], `${method} ${url}`).not.toContain(status);
    }
  });
});
