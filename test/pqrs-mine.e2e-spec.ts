import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPqrs, createPqrsMessage, createPqrsType, createUser } from './utils/factories.js';
import { adminCaller, studentCaller, teacherCaller } from './utils/pqrs.js';
import { createTestApp, PQRS_ITEM_IDS, type TestContext } from './utils/test-app.js';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('read my PQRS (spec 017, story 2)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('lists only my PQRS, newest first, with the total and the page', async () => {
    const me = await studentCaller(ctx);
    const other = await teacherCaller(ctx);
    const old = await createPqrs(ctx.prisma, { authorId: me.user.id, createdAt: minutesAgo(30), subject: 'Vieja' });
    const recent = await createPqrs(ctx.prisma, { authorId: me.user.id, createdAt: minutesAgo(5), subject: 'Reciente' });
    await createPqrs(ctx.prisma, { authorId: other.user.id });
    await createPqrs(ctx.prisma, { authorId: me.user.id, deletedAt: new Date() });

    const res = await me.get('/pqrs/mine');
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([recent.id, old.id]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    const paged = await me.get('/pqrs/mine?page=2&limit=1');
    expect(paged.body.data.map((p: { id: string }) => p.id)).toEqual([old.id]);
    expect(paged.body.meta).toEqual({ page: 2, limit: 1, total: 2 });
  });

  it('filters by status and answers an empty page when there is nothing', async () => {
    const me = await studentCaller(ctx);
    expect((await me.get('/pqrs/mine')).body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0 } });
    await createPqrs(ctx.prisma, { authorId: me.user.id, status: 'FILED' });
    const resolved = await createPqrs(ctx.prisma, { authorId: me.user.id, status: 'RESOLVED' });
    const res = await me.get('/pqrs/mine?status=RESOLVED');
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([resolved.id]);
    expect(res.body.meta.total).toBe(1);
    expect((await me.get('/pqrs/mine?status=NOPE')).status).toBe(400);
  });

  it('opens one of mine with its description and the replies in chronological order', async () => {
    const me = await teacherCaller(ctx);
    const cae = await adminCaller(ctx);
    const pqrs = await createPqrs(ctx.prisma, { authorId: me.user.id, status: 'IN_REVIEW', description: 'Detalle largo' });
    const first = await createPqrsMessage(ctx.prisma, pqrs.id, cae.user.id, 'Primera');
    await ctx.prisma.pqrsMessage.update({ where: { id: first.id }, data: { createdAt: minutesAgo(10) } });
    await createPqrsMessage(ctx.prisma, pqrs.id, cae.user.id, 'Segunda');
    await createPqrsMessage(ctx.prisma, pqrs.id, cae.user.id, 'Borrada').then((m) =>
      ctx.prisma.pqrsMessage.update({ where: { id: m.id }, data: { deletedAt: new Date() } }),
    );

    const res = await me.get(`/pqrs/mine/${pqrs.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: pqrs.id, description: 'Detalle largo', status: 'IN_REVIEW' });
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(['Primera', 'Segunda']);
  });

  // Spec 020: the author gets the dates of the steps after filing, for the timeline of the detail.
  it('gives the dates of the steps in the detail: null until each step happens', async () => {
    const me = await studentCaller(ctx);
    const filed = await createPqrs(ctx.prisma, { authorId: me.user.id });
    const inReview = await createPqrs(ctx.prisma, { authorId: me.user.id, status: 'IN_REVIEW' });
    const resolved = await createPqrs(ctx.prisma, { authorId: me.user.id, status: 'RESOLVED' });
    const dates = async (id: string) => {
      const { status, body } = await me.get(`/pqrs/mine/${id}`);
      expect(status).toBe(200);
      return { reviewedAt: body.reviewedAt, resolvedAt: body.resolvedAt };
    };

    expect(await dates(filed.id)).toEqual({ reviewedAt: null, resolvedAt: null });
    const review = await dates(inReview.id);
    expect(review.reviewedAt).toBe(inReview.reviewedAt?.toISOString());
    expect(review.resolvedAt).toBeNull();
    const done = await dates(resolved.id);
    expect(done.reviewedAt).toBe(resolved.reviewedAt?.toISOString());
    expect(done.resolvedAt).toBe(resolved.resolvedAt?.toISOString());
  });

  it('keeps the list light: the summary of my PQRS still has no step dates', async () => {
    const me = await studentCaller(ctx);
    await createPqrs(ctx.prisma, { authorId: me.user.id, status: 'RESOLVED' });
    const { body } = await me.get('/pqrs/mine');
    expect(body.data[0]).not.toHaveProperty('reviewedAt');
    expect(body.data[0]).not.toHaveProperty('resolvedAt');
  });

  it('answers 404 PQRS_NOT_FOUND for the PQRS of another user, a deleted one and an unknown id', async () => {
    const me = await studentCaller(ctx);
    const other = await teacherCaller(ctx);
    const theirs = await createPqrs(ctx.prisma, { authorId: other.user.id });
    const mineDeleted = await createPqrs(ctx.prisma, { authorId: me.user.id, deletedAt: new Date() });
    for (const id of [theirs.id, mineDeleted.id, crypto.randomUUID()]) {
      const res = await me.get(`/pqrs/mine/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PQRS_NOT_FOUND');
    }
    expect((await me.get('/pqrs/mine/not-a-uuid')).status).toBe(400);
  });

  it('keeps the type labels of a PQRS after its type is deactivated', async () => {
    const me = await studentCaller(ctx);
    const type = await createPqrsType(ctx.prisma, { labelEs: 'Felicitación', labelEn: 'Praise' });
    const pqrs = await createPqrs(ctx.prisma, { authorId: me.user.id, typeId: type.id });
    await ctx.prisma.dropdownItem.update({ where: { id: type.id }, data: { status: 'INACTIVE' } });
    expect((await me.get(`/pqrs/mine/${pqrs.id}`)).body.type).toEqual({ id: type.id, labelEs: 'Felicitación', labelEn: 'Praise' });
    expect((await me.get('/pqrs/mine')).body.data[0].type.labelEn).toBe('Praise');
  });

  it('still lists the PQRS of an author whose account was later deactivated, for the CAE (see pqrs-admin)', async () => {
    const author = await createUser(ctx.prisma, { role: 'STUDENT', status: 'INACTIVE' });
    const pqrs = await createPqrs(ctx.prisma, { authorId: author.id, typeId: PQRS_ITEM_IDS[1] });
    expect(await ctx.prisma.pqrs.count({ where: { id: pqrs.id } })).toBe(1);
  });
});
