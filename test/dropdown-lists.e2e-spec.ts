import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, PQRS_ITEM_IDS, type TestContext } from './utils/test-app.js';

describe('dropdown lists (US3)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const res = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: TEST_PASSWORD });
    token = res.body.accessToken as string;
  });
  afterAll(() => ctx.close());

  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
  const call = (method: Method, path: string) =>
    ctx.http()[method](`/api/v1/dropdown-lists${path}`).set('Authorization', `Bearer ${token}`);
  const labels = (res: { body: { items?: { labelEs: string }[] } | { labelEs: string }[] }) =>
    (Array.isArray(res.body) ? res.body : (res.body.items ?? [])).map((i) => i.labelEs);

  it('ships the PQRS types list with four bilingual items', async () => {
    const lists = await call('get', '');
    expect(lists.body).toEqual([
      { key: 'PQRS_TYPE', nameEs: 'Tipos de PQRS', nameEn: 'PQRS types', itemCount: 4 },
    ]);
    const detail = await call('get', '/PQRS_TYPE');
    expect(detail.body.items.map((i: { labelEs: string; labelEn: string }) => [i.labelEs, i.labelEn])).toEqual([
      ['Petición', 'Request'],
      ['Queja', 'Complaint'],
      ['Reclamo', 'Claim'],
      ['Sugerencia', 'Suggestion'],
    ]);
  });

  it('adds an item at the end, active, with both labels', async () => {
    const res = await call('post', '/PQRS_TYPE/items').send({ labelEs: ' Felicitación ', labelEn: 'Compliment' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ labelEs: 'Felicitación', labelEn: 'Compliment', sortOrder: 5, status: 'ACTIVE' });
  });

  it('requires both labels, treating blank ones as empty', async () => {
    for (const body of [
      { labelEs: '   ', labelEn: 'X' },
      { labelEs: 'X', labelEn: '' },
    ]) {
      const res = await call('post', '/PQRS_TYPE/items').send(body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DROPDOWN_LABEL_REQUIRED');
    }
    const edit = await call('patch', `/PQRS_TYPE/items/${PQRS_ITEM_IDS[0]}`).send({ labelEn: ' ' });
    expect(edit.body.code).toBe('DROPDOWN_LABEL_REQUIRED');
  });

  it('reorders and persists the order', async () => {
    const reversed = [...PQRS_ITEM_IDS].reverse();
    const res = await call('put', '/PQRS_TYPE/items/order').send({ itemIds: reversed });
    expect(res.status).toBe(200);
    expect(labels(res)).toEqual(['Sugerencia', 'Reclamo', 'Queja', 'Petición']);
    expect(labels(await call('get', '/PQRS_TYPE'))).toEqual(['Sugerencia', 'Reclamo', 'Queja', 'Petición']);
  });

  it('rejects an order that misses or repeats items', async () => {
    const missing = await call('put', '/PQRS_TYPE/items/order').send({ itemIds: PQRS_ITEM_IDS.slice(1) });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('DROPDOWN_ORDER_INVALID');
    const unknown = await call('put', '/PQRS_TYPE/items/order').send({
      itemIds: [...PQRS_ITEM_IDS.slice(1), 'a1b2c3d4-0002-4000-8000-0000000000ff'],
    });
    expect(unknown.body.code).toBe('DROPDOWN_ORDER_INVALID');
  });

  it('shows selectors only the active items, in order, to any role', async () => {
    await call('patch', `/PQRS_TYPE/items/${PQRS_ITEM_IDS[1]}`).send({ status: 'INACTIVE' });
    await call('put', '/PQRS_TYPE/items/order').send({
      itemIds: [PQRS_ITEM_IDS[3], PQRS_ITEM_IDS[2], PQRS_ITEM_IDS[1], PQRS_ITEM_IDS[0]],
    });
    const student = await createUser(ctx.prisma, { role: 'STUDENT' });
    const login = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: student.email, password: TEST_PASSWORD });
    const res = await ctx
      .http()
      .get('/api/v1/dropdown-lists/PQRS_TYPE/items')
      .set('Authorization', `Bearer ${login.body.accessToken as string}`);
    expect(res.status).toBe(200);
    expect(labels(res)).toEqual(['Sugerencia', 'Reclamo', 'Petición']);
    expect(res.body[0]).toHaveProperty('labelEn', 'Suggestion');
  });

  it('only deactivates an item in use, and deletes an unused one logically', async () => {
    ctx.usage.itemsInUse.add(PQRS_ITEM_IDS[0]);
    const blocked = await call('delete', `/PQRS_TYPE/items/${PQRS_ITEM_IDS[0]}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('DROPDOWN_ITEM_IN_USE');
    const detail = await call('get', '/PQRS_TYPE');
    expect(detail.body.items[0]).toMatchObject({ inUse: true });
    expect((await call('patch', `/PQRS_TYPE/items/${PQRS_ITEM_IDS[0]}`).send({ status: 'INACTIVE' })).status).toBe(200);

    expect((await call('delete', `/PQRS_TYPE/items/${PQRS_ITEM_IDS[1]}`)).status).toBe(204);
    const row = await ctx.prisma.dropdownItem.findUniqueOrThrow({ where: { id: PQRS_ITEM_IDS[1] } });
    expect(row.deletedAt).not.toBeNull();
    const after = await call('get', '/PQRS_TYPE');
    expect(after.body.items.map((i: { sortOrder: number }) => i.sortOrder)).toEqual([1, 2, 3]);
  });

  it('does not let anyone create, rename or delete lists', async () => {
    expect((await call('post', '').send({ key: 'X', nameEs: 'X', nameEn: 'X' })).status).toBe(404);
    expect((await call('patch', '/PQRS_TYPE').send({ nameEs: 'X' })).status).toBe(404);
    expect((await call('delete', '/PQRS_TYPE')).status).toBe(404);
    expect((await call('get', '/UNKNOWN')).status).toBe(404);
  });
});
