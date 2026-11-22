import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadContract, specPath } from './utils/contract.js';
import { createPqrs, createPqrsType } from './utils/factories.js';
import { adminCaller, pqrsBody, studentCaller, teacherCaller, type Caller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('017-pqrs/contracts/pqrs-api.yaml'));
const NOBODY = '00000000-0000-4000-8000-000000000999';

// Real answers of the 9 endpoints against specs/017-pqrs/contracts/pqrs-api.yaml.
describe.skipIf(!contract.available)('responses match pqrs-api.yaml', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const check = <T extends { status: number; body: unknown }>(res: T, method: string, path: string, schema: string): T => {
    contract.assertDocumented(method, path, res.status);
    contract.assertMatchesSchema(schema, res.body);
    return res;
  };
  const forbidden = async (caller: Caller, method: 'get' | 'post', url: string, path: string) =>
    check(await caller[method](url), method, path, 'Error');

  it('the author side: limits, file, retry, list and detail', async () => {
    const me = await studentCaller(ctx);
    const body = pqrsBody();
    check(await me.get('/pqrs/limits'), 'get', '/pqrs/limits', 'PqrsLimits');
    const filed = check(await me.post('/pqrs', body), 'post', '/pqrs', 'PqrsMine');
    check(await me.post('/pqrs', body), 'post', '/pqrs', 'PqrsMine');
    check(await me.post('/pqrs', pqrsBody({ subject: '' })), 'post', '/pqrs', 'Error');
    const inactive = await createPqrsType(ctx.prisma, { status: 'INACTIVE' });
    check(await me.post('/pqrs', pqrsBody({ typeId: inactive.id })), 'post', '/pqrs', 'Error');

    check(await me.get('/pqrs/mine'), 'get', '/pqrs/mine', 'PqrsMinePage');
    check(await me.get('/pqrs/mine?status=FILED'), 'get', '/pqrs/mine', 'PqrsMinePage');
    check(await me.get(`/pqrs/mine/${filed.body.id}`), 'get', '/pqrs/mine/{id}', 'PqrsMineDetail');
    check(await me.get(`/pqrs/mine/${NOBODY}`), 'get', '/pqrs/mine/{id}', 'Error');
  });

  it('the CAE side: list, detail and the three actions with their refusals', async () => {
    const cae = await adminCaller(ctx);
    const author = await teacherCaller(ctx);
    const filed = await createPqrs(ctx.prisma, { authorId: author.user.id });
    const id = filed.id;

    check(await cae.get('/pqrs'), 'get', '/pqrs', 'PqrsAdminPage');
    check(await cae.get('/pqrs?status=FILED&authorRole=TEACHER'), 'get', '/pqrs', 'PqrsAdminPage');
    check(await cae.get('/pqrs?status=NOPE'), 'get', '/pqrs', 'Error');
    check(await cae.get(`/pqrs/${id}`), 'get', '/pqrs/{id}', 'PqrsAdminDetail');
    check(await cae.get(`/pqrs/${NOBODY}`), 'get', '/pqrs/{id}', 'Error');

    check(await cae.post(`/pqrs/${id}/responses`, { body: 'Antes de tiempo' }), 'post', '/pqrs/{id}/responses', 'Error');
    check(await cae.post(`/pqrs/${id}/resolve`), 'post', '/pqrs/{id}/resolve', 'Error');
    check(await cae.post(`/pqrs/${id}/review`), 'post', '/pqrs/{id}/review', 'PqrsAdminDetail');
    check(await cae.post(`/pqrs/${id}/review`), 'post', '/pqrs/{id}/review', 'Error');
    check(await cae.post(`/pqrs/${NOBODY}/review`), 'post', '/pqrs/{id}/review', 'Error');
    check(await cae.post(`/pqrs/${id}/responses`, { body: '' }), 'post', '/pqrs/{id}/responses', 'Error');
    check(await cae.post(`/pqrs/${id}/resolve`), 'post', '/pqrs/{id}/resolve', 'Error');
    const reply = check(await cae.post(`/pqrs/${id}/responses`, { body: 'Respuesta' }), 'post', '/pqrs/{id}/responses', 'PqrsMessage');
    expect(reply.status).toBe(201);
    check(await cae.post(`/pqrs/${id}/resolve`), 'post', '/pqrs/{id}/resolve', 'PqrsAdminDetail');
    check(await cae.post(`/pqrs/${id}/responses`, { body: 'Tarde' }), 'post', '/pqrs/{id}/responses', 'Error');
    check(await cae.post(`/pqrs/${NOBODY}/responses`, { body: 'x' }), 'post', '/pqrs/{id}/responses', 'Error');
    check(await cae.post(`/pqrs/${NOBODY}/resolve`), 'post', '/pqrs/{id}/resolve', 'Error');
  });

  it('answers 401 and 403 as documented', async () => {
    const me = await studentCaller(ctx);
    const cae = await adminCaller(ctx);
    await forbidden(me, 'get', '/pqrs', '/pqrs');
    await forbidden(me, 'post', `/pqrs/${NOBODY}/review`, '/pqrs/{id}/review');
    await forbidden(cae, 'get', '/pqrs/mine', '/pqrs/mine');
    const anonymous = await ctx.http().get('/api/v1/pqrs/limits');
    check(anonymous, 'get', '/pqrs/limits', 'Error');
  });
});
