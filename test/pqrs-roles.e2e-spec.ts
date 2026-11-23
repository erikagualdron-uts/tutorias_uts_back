import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCaller, studentCaller, teacherCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

type Method = 'get' | 'post';
// Every route of contracts/pqrs-api.yaml with the roles that may call it (spec 017).
const AUTHOR_ROUTES: [Method, string][] = [
  ['post', '/pqrs'],
  ['get', '/pqrs/mine'],
  ['get', '/pqrs/mine/:id'],
];
const CAE_ROUTES: [Method, string][] = [
  ['get', '/pqrs'],
  ['get', '/pqrs/:id'],
  ['post', '/pqrs/:id/review'],
  ['post', '/pqrs/:id/responses'],
  ['post', '/pqrs/:id/resolve'],
];

describe('PQRS routes are role-bound (spec 017)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const call = (method: Method, path: string, token?: string) => {
    const req = ctx.http()[method](`/api/v1${path.replace(':id', crypto.randomUUID())}`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send({});
  };

  it.each([...AUTHOR_ROUTES, ...CAE_ROUTES, ['get', '/pqrs/limits']] as [Method, string][])('%s %s answers 401 without a session', async (method, path) => {
    expect((await call(method, path)).status).toBe(401);
  });

  it('GET /pqrs/limits answers every signed-in role', async () => {
    for (const caller of [await adminCaller(ctx), await teacherCaller(ctx), await studentCaller(ctx)]) {
      expect((await call('get', '/pqrs/limits', caller.token)).status).toBe(200);
    }
  });

  it.each(AUTHOR_ROUTES)('%s %s answers 403 to the CAE', async (method, path) => {
    const cae = await adminCaller(ctx);
    expect((await call(method, path, cae.token)).status).toBe(403);
  });

  it.each(CAE_ROUTES)('%s %s answers 403 to teachers and students', async (method, path) => {
    for (const caller of [await teacherCaller(ctx), await studentCaller(ctx)]) {
      expect((await call(method, path, caller.token)).status).toBe(403);
    }
  });
});
