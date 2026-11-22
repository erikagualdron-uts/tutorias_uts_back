import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatRetentionTask } from '../src/chat/chat-retention.task.js';
import { createChatMessage } from './utils/chat.js';
import { chatWorld, directWith, moduleChatOf } from './utils/chat-world.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const monthsAgo = (months: number, extraDays = 0) => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  date.setUTCDate(date.getUTCDate() - extraDays);
  return date;
};

describe('chat retention (spec 018, story 6)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const run = () => ctx.app.get(ChatRetentionTask).run();
  const alive = (id: string) => ctx.prisma.message.findUniqueOrThrow({ where: { id } }).then((m) => m.deletedAt === null);

  it('deletes module messages and announcements after 6 months and keeps the younger ones', async () => {
    const { teacher, module } = await chatWorld(ctx);
    const id = await moduleChatOf(teacher, module.id);
    const old = await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id, createdAt: monthsAgo(7) });
    const oldAnnouncement = await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id, kind: 'ANNOUNCEMENT', createdAt: monthsAgo(6, 2) });
    const young = await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id, createdAt: monthsAgo(5) });
    expect(await run()).toEqual({ module: 2, direct: 0 });
    expect(await alive(old.id)).toBe(false);
    expect(await alive(oldAnnouncement.id)).toBe(false);
    expect(await alive(young.id)).toBe(true);
  });

  it('keeps a direct message of 8 months and deletes one of more than 2 years', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    const eight = await createChatMessage(ctx.prisma, { conversationId: id, senderId: student.user.id, createdAt: monthsAgo(8) });
    const ancient = await createChatMessage(ctx.prisma, { conversationId: id, senderId: student.user.id, createdAt: monthsAgo(25) });
    expect(await run()).toEqual({ module: 0, direct: 1 });
    expect(await alive(eight.id)).toBe(true);
    expect(await alive(ancient.id)).toBe(false);
  });

  it('follows the periods stored in settings', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    await ctx.prisma.setting.create({ data: { key: 'chat.directRetentionMonths', value: 1 } });
    const twoMonths = await createChatMessage(ctx.prisma, { conversationId: id, senderId: student.user.id, createdAt: monthsAgo(2) });
    await run();
    expect(await alive(twoMonths.id)).toBe(false);
  });

  it('is idempotent and does not touch what was already deleted', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    const gone = await createChatMessage(ctx.prisma, { conversationId: id, senderId: student.user.id, createdAt: monthsAgo(30) });
    expect(await run()).toEqual({ module: 0, direct: 1 });
    const stamp = (await ctx.prisma.message.findUniqueOrThrow({ where: { id: gone.id } })).deletedAt;
    expect(await run()).toEqual({ module: 0, direct: 0 });
    expect((await ctx.prisma.message.findUniqueOrThrow({ where: { id: gone.id } })).deletedAt).toEqual(stamp);
  });

  it('drops a direct conversation left without messages from the list and keeps the module chat listed', async () => {
    const { student, teacher, module } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    await createChatMessage(ctx.prisma, { conversationId: id, senderId: student.user.id, createdAt: monthsAgo(30) });
    const chat = await moduleChatOf(teacher, module.id);
    await createChatMessage(ctx.prisma, { conversationId: chat, senderId: teacher.user.id, createdAt: monthsAgo(7) });
    expect((await teacher.get('/chat/conversations')).body).toHaveLength(2);
    await run();
    const list = (await teacher.get('/chat/conversations')).body;
    expect(list.map((c: { id: string }) => c.id)).toEqual([chat]);
    expect(list[0]).toMatchObject({ lastMessage: null, unread: 0 });
    expect((await teacher.get('/chat/unread-count')).body).toEqual({ unread: 0 });
  });
});
