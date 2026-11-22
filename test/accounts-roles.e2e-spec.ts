import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminSession, createStudent, createTeacher, createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// Every route of contracts/accounts-api.yaml; each user story appends its own rows.
const ROUTES: [method: 'get' | 'post' | 'patch' | 'delete', path: string][] = [
  ['get', '/teachers'],
  ['get', '/teachers/:id'],
  ['get', '/students'],
  ['get', '/students/:id'],
  ['post', '/teachers/:id/deactivate'],
  ['post', '/teachers/:id/reactivate'],
  ['patch', '/teachers/:id'],
  ['post', '/teachers/:id/temporary-password'],
  ['delete', '/teachers/:id'],
  ['post', '/students/:id/deactivate'],
  ['post', '/students/:id/reactivate'],
  ['delete', '/students/:id'],
];

describe('account routes are CAE-only (spec 016)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const call = (method: (typeof ROUTES)[number][0], path: string, id: string, token?: string) => {
    const req = ctx.http()[method](`/api/v1${path.replace(':id', id)}`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send({});
  };
  const tokenOf = async (email: string) =>
    (await ctx.http().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD })).body.accessToken as string;

  it.each(ROUTES)('%s %s answers 401 without a session and 403 to teachers and students', async (method, path) => {
    const id = crypto.randomUUID();
    expect((await call(method, path, id)).status).toBe(401);
    for (const user of [await createTeacher(ctx.prisma), await createStudent(ctx.prisma)]) {
      const res = await call(method, path, id, await tokenOf(user.email));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('answers 404 ACCOUNT_NOT_FOUND to a SUPERADMIN pointing at an administrator', async () => {
    const { admin, token } = await createAdminSession(ctx);
    const other = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    for (const target of [admin.id, other.id]) {
      for (const path of ['/teachers/:id', '/students/:id']) {
        const res = await call('get', path, target, token);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
      }
    }
  });
});
