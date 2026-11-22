import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPqrs, createPqrsMessage, createStudent, createTeacher, createUser } from './utils/factories.js';
import { adminCaller } from './utils/pqrs.js';
import { createTestApp, PQRS_ITEM_IDS, type TestContext } from './utils/test-app.js';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((p) => p.id);

describe('the CAE reads every PQRS (spec 017, story 3)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  async function seed() {
    const student = await createStudent(ctx.prisma, { firstName: 'Ana', lastName: 'Soto' });
    const teacher = await createTeacher(ctx.prisma);
    const a = await createPqrs(ctx.prisma, { authorId: student.id, status: 'FILED', typeId: PQRS_ITEM_IDS[0], createdAt: minutesAgo(40) });
    const b = await createPqrs(ctx.prisma, { authorId: student.id, status: 'IN_REVIEW', typeId: PQRS_ITEM_IDS[1], createdAt: minutesAgo(30) });
    const c = await createPqrs(ctx.prisma, { authorId: teacher.id, status: 'FILED', typeId: PQRS_ITEM_IDS[1], createdAt: minutesAgo(20) });
    const d = await createPqrs(ctx.prisma, { authorId: teacher.id, status: 'RESOLVED', typeId: PQRS_ITEM_IDS[0], createdAt: minutesAgo(10) });
    return { student, teacher, a, b, c, d };
  }

  it('lists every PQRS newest first, with the author and the page', async () => {
    const { student, teacher, a, b, c, d } = await seed();
    await createPqrs(ctx.prisma, { authorId: student.id, deletedAt: new Date() });
    const cae = await adminCaller(ctx);
    const res = await cae.get('/pqrs');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([d.id, c.id, b.id, a.id]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4 });
    const own = res.body.data.find((p: { id: string }) => p.id === a.id);
    expect(own.author).toEqual({ id: student.id, role: 'STUDENT', firstName: 'Ana', lastName: 'Soto', email: student.email });
    expect(res.body.data.find((p: { id: string }) => p.id === c.id).author.role).toBe(teacher.role);
    const page = await cae.get('/pqrs?page=2&limit=3');
    expect(ids(page)).toEqual([a.id]);
  });

  it.each([
    ['status', '?status=FILED', ['c', 'a']],
    ['type', `?typeId=${PQRS_ITEM_IDS[1]}`, ['c', 'b']],
    ['author role STUDENT', '?authorRole=STUDENT', ['b', 'a']],
    ['author role TEACHER', '?authorRole=TEACHER', ['d', 'c']],
    ['status and type', `?status=FILED&typeId=${PQRS_ITEM_IDS[1]}`, ['c']],
    ['the three filters', `?status=RESOLVED&typeId=${PQRS_ITEM_IDS[0]}&authorRole=TEACHER`, ['d']],
    ['filters with no match', `?status=RESOLVED&authorRole=STUDENT`, []],
  ])('filters by %s', async (_name, query, expected) => {
    const rows = await seed();
    const cae = await adminCaller(ctx);
    const res = await cae.get(`/pqrs${query}`);
    expect(ids(res)).toEqual(expected.map((key) => rows[key as 'a'].id));
    expect(res.body.meta.total).toBe(expected.length);
  });

  it('counts by status through the total of each filtered list (what the dashboards read)', async () => {
    await seed();
    const cae = await adminCaller(ctx);
    const totals = await Promise.all(['FILED', 'IN_REVIEW', 'RESOLVED'].map(async (s) => (await cae.get(`/pqrs?status=${s}&limit=1`)).body.meta.total));
    expect(totals).toEqual([2, 1, 1]);
  });

  it('rejects an invalid filter with 400', async () => {
    const cae = await adminCaller(ctx);
    for (const query of ['?status=NOPE', '?authorRole=SUPERADMIN', '?typeId=nope']) expect((await cae.get(`/pqrs${query}`)).status).toBe(400);
  });

  it('opens any PQRS with the author, the replies and the dates', async () => {
    const { student, b } = await seed();
    const cae = await adminCaller(ctx);
    await createPqrsMessage(ctx.prisma, b.id, cae.user.id, 'Estamos en ello');
    const res = await cae.get(`/pqrs/${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: b.id, status: 'IN_REVIEW', author: { email: student.email }, resolvedAt: null });
    expect(res.body.reviewedAt).not.toBeNull();
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(['Estamos en ello']);
  });

  it('answers 404 PQRS_NOT_FOUND for an unknown or deleted PQRS', async () => {
    const { student } = await seed();
    const deleted = await createPqrs(ctx.prisma, { authorId: student.id, deletedAt: new Date() });
    const cae = await adminCaller(ctx);
    for (const id of [crypto.randomUUID(), deleted.id]) {
      const res = await cae.get(`/pqrs/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PQRS_NOT_FOUND');
    }
  });

  it('keeps showing the PQRS of an author whose account is deactivated or deleted', async () => {
    const inactive = await createUser(ctx.prisma, { role: 'STUDENT', status: 'INACTIVE' });
    const removed = await createUser(ctx.prisma, { role: 'TEACHER', deletedAt: new Date() });
    const one = await createPqrs(ctx.prisma, { authorId: inactive.id });
    const two = await createPqrs(ctx.prisma, { authorId: removed.id });
    const cae = await adminCaller(ctx);
    const res = await cae.get('/pqrs');
    expect(ids(res).sort()).toEqual([one.id, two.id].sort());
    expect((await cae.get(`/pqrs/${two.id}`)).body.author.email).toBe(removed.email);
  });
});
