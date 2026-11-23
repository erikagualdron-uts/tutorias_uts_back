import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAllChatClients, connectChat } from './utils/chat.js';
import { chatWorld, directWith, messageBody, sendTo } from './utils/chat-world.js';
import { signIn } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('realtime delivery (spec 018, story 3)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterEach(() => closeAllChatClients());
  afterAll(() => ctx.close());

  describe('connection', () => {
    it('refuses a missing or invalid token with TOKEN_INVALID', async () => {
      await chatWorld(ctx);
      for (const token of ['', 'not-a-token']) {
        const client = await connectChat(ctx, token);
        expect(client.connected).toBe(false);
        expect(client.error?.data?.code).toBe('TOKEN_INVALID');
      }
    });

    it('refuses the token of a revoked session and of a deactivated account, with their codes', async () => {
      const { student, teacher } = await chatWorld(ctx);
      await ctx.prisma.session.updateMany({ where: { userId: student.user.id }, data: { revokedAt: new Date() } });
      const revoked = await connectChat(ctx, student.token);
      expect(revoked.connected).toBe(false);
      expect(revoked.error?.data?.code).toBe('SESSION_REVOKED');
      await ctx.prisma.user.update({ where: { id: teacher.user.id }, data: { status: 'INACTIVE' } });
      const disabled = await connectChat(ctx, teacher.token);
      expect(disabled.connected).toBe(false);
      expect(disabled.error?.data?.code).toBe('ACCOUNT_DISABLED');
    });

    it('accepts a valid token', async () => {
      const { student } = await chatWorld(ctx);
      expect((await connectChat(ctx, student.token)).connected).toBe(true);
    });
  });

  describe('opening a conversation', () => {
    it('acknowledges a conversation of mine and refuses one that is not', async () => {
      const { student, teacher, cae } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const mine = await connectChat(ctx, student.token);
      expect(await mine.emitWithAck('conversation:open', { conversationId: id })).toEqual({ ok: true });
      const outsider = await connectChat(ctx, cae.token);
      expect(await outsider.emitWithAck('conversation:open', { conversationId: id })).toEqual({ ok: false, code: 'CHAT_NOT_FOUND' });
      expect(await outsider.emitWithAck('conversation:open', {})).toEqual({ ok: false, code: 'CHAT_NOT_FOUND' });
    });
  });

  describe('message:new', () => {
    it('reaches the recipient and the other device of the sender, never a third person', async () => {
      const { student, teacher, cae } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const recipient = await connectChat(ctx, teacher.token);
      const senderPhone = await connectChat(ctx, student.token);
      const senderTablet = await connectChat(ctx, (await signIn(ctx, student.user)).token);
      const third = await connectChat(ctx, cae.token);

      const sent = await sendTo(student, id, { body: 'Hola en vivo' });
      expect(sent.status).toBe(201);

      for (const client of [recipient, senderPhone, senderTablet]) {
        expect(await client.waitFor('message:new')).toMatchObject({ id: sent.body.id, conversationId: id, body: 'Hola en vivo', sender: { id: student.user.id } });
      }
      await pause(300);
      expect(third.events.filter((e) => e.name === 'message:new')).toHaveLength(0);
    });

    it('is emitted only after the message is saved', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const recipient = await connectChat(ctx, teacher.token);
      const waiting = recipient.waitFor<{ id: string }>('message:new');
      const sent = await sendTo(student, id);
      const arrived = await waiting;
      expect(arrived.id).toBe(sent.body.id);
      const history = await teacher.get(`/chat/conversations/${id}/messages`);
      expect(history.body.data.map((m: { id: string }) => m.id)).toContain(arrived.id);
    });

    it('arrives in under two seconds', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const recipient = await connectChat(ctx, teacher.token);
      const started = Date.now();
      const waiting = recipient.waitFor('message:new');
      await sendTo(student, id);
      await waiting;
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('is not emitted again for a retry of the same message', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const recipient = await connectChat(ctx, teacher.token);
      const body = messageBody();
      await student.post(`/chat/conversations/${id}/messages`, body);
      await student.post(`/chat/conversations/${id}/messages`, body);
      await pause(400);
      expect(recipient.events.filter((e) => e.name === 'message:new')).toHaveLength(1);
    });

    it('does not reach a recipient whose account was deactivated while connected', async () => {
      const { student, teacher, cae } = await chatWorld(ctx);
      const { id } = await directWith(cae, teacher);
      const online = await connectChat(ctx, teacher.token);
      await ctx.prisma.user.update({ where: { id: teacher.user.id }, data: { status: 'INACTIVE' } });
      expect((await sendTo(cae, id)).status).toBe(409);
      await pause(300);
      expect(online.events.filter((e) => e.name === 'message:new')).toHaveLength(0);
      void student;
    });
  });

  describe('unread:changed', () => {
    it('tells the recipient the new total when a message arrives', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const recipient = await connectChat(ctx, teacher.token);
      await sendTo(student, id);
      expect(await recipient.waitFor('unread:changed')).toEqual({ unread: 1 });
      expect((await teacher.get('/chat/unread-count')).body).toEqual({ unread: 1 });
    });

    it('tells every device of the same person when they read, so the totals match', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      await sendTo(student, id);
      await sendTo(student, id);
      const phone = await connectChat(ctx, teacher.token);
      const tablet = await connectChat(ctx, (await signIn(ctx, teacher.user)).token);
      await teacher.post(`/chat/conversations/${id}/read`);
      for (const device of [phone, tablet]) expect(await device.waitFor('unread:changed')).toEqual({ unread: 0 });
    });
  });
});
