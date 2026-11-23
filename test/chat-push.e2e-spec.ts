import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS } from '../src/redis/redis.module.js';
import { closeAllChatClients, connectChat } from './utils/chat.js';
import { chatWorld, directWith, sendTo } from './utils/chat-world.js';
import type { Caller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';
import type { Redis } from 'ioredis';

const PHONE = 'ExponentPushToken[chat-teacher-phone]';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The push of a direct chat message for whoever does not have the conversation open (spec 018, story 4).
describe('chat push', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterEach(() => closeAllChatClients());
  afterAll(() => ctx.close());

  const register = (who: Caller, token = PHONE) =>
    ctx.http().put('/api/v1/notifications/devices').set('Authorization', `Bearer ${who.token}`).send({ token, platform: 'ANDROID' }).expect(204);
  const pushes = (token = PHONE) => ctx.push.to(token);
  const scenario = async () => {
    const world = await chatWorld(ctx);
    const { id } = await directWith(world.student, world.teacher);
    await register(world.teacher);
    return { ...world, id };
  };

  it('sends the name of the writer as title, the text as body and the conversation as data', async () => {
    const { student, id } = await scenario();
    const sent = await sendTo(student, id, { body: 'Profe, una pregunta' });
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    expect(pushes()[0]).toMatchObject({
      title: `${sent.body.sender.firstName} ${sent.body.sender.lastName}`,
      body: 'Profe, una pregunta',
      data: { conversationId: id },
    });
    expect(Object.keys(pushes()[0].data)).toEqual(['conversationId']);
  });

  it('cuts a long text to 140 characters and never carries an email or a phone', async () => {
    const { student, id } = await scenario();
    await sendTo(student, id, { body: 'x'.repeat(300) });
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    expect(pushes()[0].body).toHaveLength(140);
    expect(pushes()[0].body.endsWith('…')).toBe(true);
    expect(JSON.stringify(pushes()[0])).not.toContain(student.user.email);
  });

  it('does not push when the recipient has that conversation open', async () => {
    const { student, teacher, id } = await scenario();
    const open = await connectChat(ctx, teacher.token);
    expect(await open.emitWithAck('conversation:open', { conversationId: id })).toEqual({ ok: true });
    await sendTo(student, id);
    await pause(400);
    expect(ctx.push.sent).toHaveLength(0);
  });

  it('pushes again once the conversation is closed', async () => {
    const { student, teacher, id } = await scenario();
    const open = await connectChat(ctx, teacher.token);
    await open.emitWithAck('conversation:open', { conversationId: id });
    await open.emitWithAck('conversation:close', { conversationId: id });
    await sendTo(student, id);
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
  });

  it('sends one push for a burst and another one when the burst window has passed', async () => {
    const { student, id } = await scenario();
    for (let i = 0; i < 3; i += 1) await sendTo(student, id, { body: `mensaje ${i}` });
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    await pause(300);
    expect(pushes()).toHaveLength(1);
    const redis = ctx.app.get<Redis>(REDIS);
    const keys = await redis.keys('chat:push:*');
    expect(keys).toHaveLength(1);
    expect(await redis.ttl(keys[0])).toBeGreaterThan(0);
    await redis.del(keys);
    await sendTo(student, id, { body: 'otro' });
    await vi.waitFor(() => expect(pushes()).toHaveLength(2));
  });

  it('follows the burst window stored in settings', async () => {
    const { student, id } = await scenario();
    await ctx.prisma.setting.create({ data: { key: 'chat.pushBurstSeconds', value: 5 } });
    await sendTo(student, id);
    await vi.waitFor(() => expect(pushes()).toHaveLength(1));
    const [key] = await ctx.app.get<Redis>(REDIS).keys('chat:push:*');
    expect(await ctx.app.get<Redis>(REDIS).ttl(key)).toBeLessThanOrEqual(5);
  });

  it('keeps the message unread and saved when the recipient has no device', async () => {
    const { student, teacher } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    const sent = await sendTo(student, id);
    expect(sent.status).toBe(201);
    await pause(300);
    expect(ctx.push.sent).toHaveLength(0);
    expect((await teacher.get('/chat/unread-count')).body).toEqual({ unread: 1 });
  });

  it('drops a device that the push service says does not exist', async () => {
    const { student, id } = await scenario();
    ctx.push.ticketErrors.set(PHONE, 'DEVICE_NOT_REGISTERED');
    await sendTo(student, id);
    await vi.waitFor(async () => expect((await ctx.prisma.pushToken.findFirstOrThrow({ where: { token: PHONE } })).deletedAt).not.toBeNull());
  });

  it('does not fail the send when the push service is down', async () => {
    const { student, id } = await scenario();
    ctx.push.failNext = 1;
    const sent = await sendTo(student, id);
    expect(sent.status).toBe(201);
    await pause(300);
    expect(await ctx.prisma.message.count()).toBe(1);
  });

  it('does not push to the writer', async () => {
    const { teacher, student, id } = await scenario();
    await register(student, 'ExponentPushToken[chat-student-phone]');
    await sendTo(teacher, id, { body: 'Respuesta' });
    await vi.waitFor(() => expect(ctx.push.to('ExponentPushToken[chat-student-phone]')).toHaveLength(1));
    expect(pushes()).toHaveLength(0);
  });
});
