import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPqrs, createPqrsType, createStudent } from './utils/factories.js';
import { adminCaller, studentCaller } from './utils/pqrs.js';
import { createTestApp, PQRS_ITEM_IDS, type TestContext } from './utils/test-app.js';

// A type of "Tipos de PQRS" with PQRS filed under it can only be deactivated (spec 017, story 5, D-073).
describe('PQRS types in use', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const asCae = async () => {
    const { token } = await adminCaller(ctx);
    return (method: 'get' | 'patch' | 'delete', path: string) => ctx.http()[method](`/api/v1/dropdown-lists/PQRS_TYPE${path}`).set('Authorization', `Bearer ${token}`);
  };

  it('blocks deleting a type with PQRS, also when the PQRS was deleted, and shows it in use', async () => {
    const author = await createStudent(ctx.prisma);
    const live = await createPqrsType(ctx.prisma);
    const removed = await createPqrsType(ctx.prisma);
    await createPqrs(ctx.prisma, { authorId: author.id, typeId: live.id });
    await createPqrs(ctx.prisma, { authorId: author.id, typeId: removed.id, deletedAt: new Date() });
    const call = await asCae();
    for (const item of [live, removed]) {
      const res = await call('delete', `/items/${item.id}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DROPDOWN_ITEM_IN_USE');
      expect((await ctx.prisma.dropdownItem.findUniqueOrThrow({ where: { id: item.id } })).deletedAt).toBeNull();
    }
    const detail = await call('get', '');
    expect(detail.body.items.find((i: { id: string }) => i.id === live.id)).toMatchObject({ inUse: true });
    expect(detail.body.items.find((i: { id: string }) => i.id === PQRS_ITEM_IDS[0])).toMatchObject({ inUse: false });
  });

  it('deletes a type without PQRS, logically', async () => {
    const call = await asCae();
    expect((await call('delete', `/items/${PQRS_ITEM_IDS[3]}`)).status).toBe(204);
    expect((await ctx.prisma.dropdownItem.findUniqueOrThrow({ where: { id: PQRS_ITEM_IDS[3] } })).deletedAt).not.toBeNull();
  });

  it('lets the CAE deactivate a type in use and the PQRS keeps showing its labels', async () => {
    const me = await studentCaller(ctx);
    const type = await createPqrsType(ctx.prisma, { labelEs: 'Felicitación', labelEn: 'Praise' });
    const pqrs = await createPqrs(ctx.prisma, { authorId: me.user.id, typeId: type.id });
    const call = await asCae();
    expect((await call('patch', `/items/${type.id}`).send({ status: 'INACTIVE' })).status).toBe(200);

    const mine = await me.get(`/pqrs/mine/${pqrs.id}`);
    expect(mine.body.type).toEqual({ id: type.id, labelEs: 'Felicitación', labelEn: 'Praise' });
    const cae = await adminCaller(ctx);
    expect((await cae.get(`/pqrs/${pqrs.id}`)).body.type.labelEn).toBe('Praise');
  });

  it('stops offering a deactivated type for new PQRS', async () => {
    const me = await studentCaller(ctx);
    const call = await asCae();
    await call('patch', `/items/${PQRS_ITEM_IDS[0]}`).send({ status: 'INACTIVE' });
    const items = await ctx.http().get('/api/v1/dropdown-lists/PQRS_TYPE/items').set('Authorization', `Bearer ${me.token}`);
    expect(items.body.map((i: { id: string }) => i.id)).not.toContain(PQRS_ITEM_IDS[0]);
    const res = await me.post('/pqrs', { clientRequestId: crypto.randomUUID(), typeId: PQRS_ITEM_IDS[0], subject: 'x', description: 'y' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PQRS_TYPE_UNAVAILABLE');
  });
});
