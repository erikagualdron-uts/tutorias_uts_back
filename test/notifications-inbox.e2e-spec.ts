import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginStudent, type Student } from './utils/enrollment.js';
import { createOutboxEvent } from './utils/factories.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// The inbox of spec 014: newest first, paginated, only the user's own, read marks (FR-009 to FR-011, FR-024).
describe('notifications: inbox', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  async function setup() {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id);
    const student = await loginStudent(ctx);
    let counter = 0;
    // One notice for `userId`, created `minutesAgo` minutes ago (each needs its own event).
    const notice = async (userId: string, minutesAgo = 0, overrides: { readAt?: Date } = {}) => {
      counter += 1;
      const event = await createOutboxEvent(ctx.prisma, {
        type: 'SESSION_CANCELLED_TEACHER',
        moduleId: m.module.id,
        payload: { scope: 'SESSION', sessions: [] },
      });
      return ctx.prisma.notification.create({
        data: {
          userId,
          eventId: event.id,
          type: 'SESSION_CANCELLED_TEACHER',
          moduleId: m.module.id,
          locale: 'es',
          title: `Aviso ${counter}`,
          body: `Cuerpo ${counter}`,
          createdAt: new Date(Date.now() - minutesAgo * 60_000),
          readAt: overrides.readAt ?? null,
        },
      });
    };
    return { m, student, notice };
  }
  const list = (student: Student, query = '') => student.get(`/notifications${query}`);

  it('lists the notices from the newest to the oldest (story 2, scenario 1)', async () => {
    const { student, notice } = await setup();
    await notice(student.user.id, 30);
    await notice(student.user.id, 5);
    await notice(student.user.id, 60);
    const res = await list(student).expect(200);
    expect(res.body.data.map((n: { title: string }) => n.title)).toEqual(['Aviso 2', 'Aviso 1', 'Aviso 3']);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
  });

  it('exposes only the fields of the contract', async () => {
    const { m, student, notice } = await setup();
    await notice(student.user.id);
    const [item] = (await list(student).expect(200)).body.data;
    expect(Object.keys(item).sort()).toEqual(['body', 'createdAt', 'id', 'moduleId', 'pqrsId', 'readAt', 'title', 'type']);
    expect(item.moduleId).toBe(m.module.id);
    expect(item.pqrsId).toBeNull();
    expect(item.readAt).toBeNull();
  });

  it('answers an empty page when there are no notices (story 2, scenario 4)', async () => {
    const { student } = await setup();
    const res = await list(student).expect(200);
    expect(res.body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0 } });
  });

  it('paginates without repeating or skipping notices, even with the same creation time (scenario 6)', async () => {
    const { student, notice } = await setup();
    for (let i = 0; i < 5; i++) await notice(student.user.id, 10);
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await list(student, `?page=${page}&limit=2`).expect(200);
      expect(res.body.meta).toEqual({ page, limit: 2, total: 5 });
      seen.push(...res.body.data.map((n: { id: string }) => n.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects an invalid page or limit', async () => {
    const { student } = await setup();
    await list(student, '?page=0').expect(400);
    await list(student, '?limit=101').expect(400);
  });

  it('shows only the notices of the user (scenario 7)', async () => {
    const { student, notice } = await setup();
    const other = await loginStudent(ctx);
    await notice(student.user.id);
    await notice(other.user.id);
    await notice(other.user.id);
    expect((await list(student).expect(200)).body.meta.total).toBe(1);
    expect((await list(other).expect(200)).body.meta.total).toBe(2);
  });

  it('counts the unread notices', async () => {
    const { student, notice } = await setup();
    await notice(student.user.id);
    await notice(student.user.id);
    await notice(student.user.id, 0, { readAt: new Date() });
    const res = await student.get('/notifications/unread-count').expect(200);
    expect(res.body).toEqual({ unread: 2 });
  });

  it('marks one notice as read and the counter goes down (scenario 2)', async () => {
    const { student, notice } = await setup();
    const first = await notice(student.user.id);
    await notice(student.user.id);
    const res = await ctx.http().post(`/api/v1/notifications/${first.id}/read`).set('Authorization', `Bearer ${student.token}`).expect(200);
    expect(res.body.id).toBe(first.id);
    expect(res.body.readAt).not.toBeNull();
    expect((await student.get('/notifications/unread-count')).body).toEqual({ unread: 1 });
  });

  it('keeps the first reading date when it is marked again', async () => {
    const { student, notice } = await setup();
    const first = await notice(student.user.id);
    const read = () => ctx.http().post(`/api/v1/notifications/${first.id}/read`).set('Authorization', `Bearer ${student.token}`).expect(200);
    const once = (await read()).body.readAt;
    ctx.clock.advance(60_000);
    const twice = (await read()).body.readAt;
    expect(twice).toBe(once);
  });

  it('marks all as read and reports how many changed (scenario 3)', async () => {
    const { student, notice } = await setup();
    await notice(student.user.id);
    await notice(student.user.id);
    await notice(student.user.id, 0, { readAt: new Date() });
    const post = () => ctx.http().post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${student.token}`).expect(200);
    expect((await post()).body).toEqual({ updated: 2 });
    expect((await student.get('/notifications/unread-count')).body).toEqual({ unread: 0 });
    expect((await post()).body).toEqual({ updated: 0 });
  });

  it('answers 404 when reading a notice of another user, and leaves it unread', async () => {
    const { student, notice } = await setup();
    const other = await loginStudent(ctx);
    const foreign = await notice(other.user.id);
    const res = await ctx.http().post(`/api/v1/notifications/${foreign.id}/read`).set('Authorization', `Bearer ${student.token}`).expect(404);
    expect(res.body.code).toBe('NOTIFICATION_NOT_FOUND');
    expect((await ctx.prisma.notification.findUniqueOrThrow({ where: { id: foreign.id } })).readAt).toBeNull();
  });

  it('answers 404 for a notice that does not exist and 400 for a malformed id', async () => {
    const { student } = await setup();
    const post = (id: string) => ctx.http().post(`/api/v1/notifications/${id}/read`).set('Authorization', `Bearer ${student.token}`);
    await post('00000000-0000-4000-8000-000000000000').expect(404);
    await post('not-a-uuid').expect(400);
  });

  it('read-all never touches the notices of other users', async () => {
    const { student, notice } = await setup();
    const other = await loginStudent(ctx);
    await notice(student.user.id);
    await notice(other.user.id);
    await ctx.http().post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${student.token}`).expect(200);
    expect((await other.get('/notifications/unread-count')).body).toEqual({ unread: 1 });
  });

  it('keeps every notice whatever its age: nothing is hidden or deleted by antiquity', async () => {
    const { student, notice } = await setup();
    await notice(student.user.id, 60 * 24 * 365 * 3);
    await notice(student.user.id, 5);
    const res = await list(student).expect(200);
    expect(res.body.meta.total).toBe(2);
    expect(await ctx.prisma.notification.count()).toBe(2);
  });
});
