import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createChatMessage, createDirectConversation } from './utils/chat.js';
import { chatWorld, directWith, sendTo } from './utils/chat-world.js';
import { createEnrollment } from './utils/factories.js';
import { moduleWithSessions } from './utils/enrollment.js';
import { teacherCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('my conversations, history and unread (spec 018, story 2)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('lists only my conversations, the one with the latest message first, with last message and unread', async () => {
    const { student, teacher, cae, period } = await chatWorld(ctx);
    const other = await teacherCaller(ctx);
    const { module: second } = await moduleWithSessions(ctx, period.id, { teacherId: other.user.id });
    await createEnrollment(ctx.prisma, { studentId: student.user.id, moduleId: second.id });
    const old = await createDirectConversation(ctx.prisma, { a: student.user.id, b: teacher.user.id });
    const recent = await createDirectConversation(ctx.prisma, { a: student.user.id, b: other.user.id });
    const foreign = await createDirectConversation(ctx.prisma, { a: cae.user.id, b: teacher.user.id });
    await createChatMessage(ctx.prisma, { conversationId: old.id, senderId: teacher.user.id, body: 'Vieja', createdAt: minutesAgo(30) });
    await createChatMessage(ctx.prisma, { conversationId: recent.id, senderId: other.user.id, body: 'Reciente', createdAt: minutesAgo(5) });
    await createChatMessage(ctx.prisma, { conversationId: recent.id, senderId: student.user.id, body: 'Mia', createdAt: minutesAgo(4) });
    await createChatMessage(ctx.prisma, { conversationId: foreign.id, senderId: cae.user.id, body: 'Ajena' });

    const res = await student.get('/chat/conversations');
    expect(res.status).toBe(200);
    const direct = res.body.filter((c: { type: string }) => c.type === 'DIRECT');
    expect(direct.map((c: { id: string }) => c.id)).toEqual([recent.id, old.id]);
    expect(direct[0]).toMatchObject({ unread: 1, lastMessage: { body: 'Mia', sender: { id: student.user.id } }, partner: { id: other.user.id } });
    expect(direct[1]).toMatchObject({ unread: 1, lastMessage: { body: 'Vieja' }, partner: { id: teacher.user.id } });
    expect(direct[0].module).toBeNull();
    expect(res.body.map((c: { id: string }) => c.id)).not.toContain(foreign.id);
  });

  it('does not list a direct conversation without live messages, and does not count a deleted message', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const empty = await directWith(student, teacher);
    expect((await student.get('/chat/conversations')).body.map((c: { id: string }) => c.id)).not.toContain(empty.id);
    const sent = await createChatMessage(ctx.prisma, { conversationId: empty.id, senderId: teacher.user.id });
    await createChatMessage(ctx.prisma, { conversationId: empty.id, senderId: teacher.user.id, deletedAt: new Date() });
    const [listed] = (await student.get('/chat/conversations')).body.filter((c: { type: string }) => c.type === 'DIRECT');
    expect(listed).toMatchObject({ unread: 1, lastMessage: { id: sent.id } });
    expect((await student.get('/chat/unread-count')).body).toEqual({ unread: 1 });
  });

  it('pages the history from the newest, without gaps or repeats, even with messages of the same instant', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    const same = minutesAgo(10);
    const made = [];
    for (let i = 0; i < 7; i += 1) {
      made.push(await createChatMessage(ctx.prisma, { conversationId: id, senderId: i % 2 ? student.user.id : teacher.user.id, body: `m${i}`, createdAt: i < 4 ? same : minutesAgo(9 - i) }));
    }
    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await student.get(`/chat/conversations/${id}/messages?limit=3${before ? `&before=${before}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((m: { id: string }) => m.id));
      before = res.body.next;
      if (!before) break;
    }
    expect(before).toBeNull();
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const times = made.filter((m) => seen.includes(m.id));
    const expected = [...times].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)).map((m) => m.id);
    expect(seen).toEqual(expected);
  });

  it('rejects a limit outside 1 to 100 and a broken cursor with 400', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    for (const query of ['limit=0', 'limit=101', 'before=nonsense', `before=${Buffer.from('x|y').toString('base64url')}`]) {
      expect((await student.get(`/chat/conversations/${id}/messages?${query}`)).status).toBe(400);
    }
  });

  it('marks a conversation read without touching the others and keeps the total in step', async () => {
    const { student, teacher, cae } = await chatWorld(ctx);
    const withTeacher = await directWith(student, teacher);
    const withOther = await createDirectConversation(ctx.prisma, { a: student.user.id, b: cae.user.id });
    await createChatMessage(ctx.prisma, { conversationId: withTeacher.id, senderId: teacher.user.id });
    await createChatMessage(ctx.prisma, { conversationId: withTeacher.id, senderId: teacher.user.id });
    await createChatMessage(ctx.prisma, { conversationId: withOther.id, senderId: cae.user.id });
    expect((await student.get('/chat/unread-count')).body).toEqual({ unread: 3 });

    const read = await student.post(`/chat/conversations/${withTeacher.id}/read`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ unread: 1 });
    const list = (await student.get('/chat/conversations')).body as { id: string; unread: number }[];
    expect(list.find((c) => c.id === withTeacher.id)?.unread).toBe(0);
    expect(list.find((c) => c.id === withOther.id)?.unread).toBe(1);
    expect((await student.get('/chat/unread-count')).body).toEqual({ unread: 1 });

    await createChatMessage(ctx.prisma, { conversationId: withTeacher.id, senderId: teacher.user.id });
    expect((await student.get('/chat/unread-count')).body).toEqual({ unread: 2 });
  });

  it('never counts my own messages as unread', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    await sendTo(student, id);
    expect((await student.get('/chat/unread-count')).body).toEqual({ unread: 0 });
    expect((await teacher.get('/chat/unread-count')).body).toEqual({ unread: 1 });
  });

  it('answers an empty list when there is nothing', async () => {
    const { cae } = await chatWorld(ctx);
    expect((await cae.get('/chat/conversations')).body).toEqual([]);
    expect((await cae.get('/chat/unread-count')).body).toEqual({ unread: 0 });
  });
});
