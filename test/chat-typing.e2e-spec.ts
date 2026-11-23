import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAllChatClients, connectChat } from './utils/chat.js';
import { chatWorld, directWith, enrollAnother, moduleChatOf } from './utils/chat-world.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const typingOf = (client: { events: { name: string }[] }) => client.events.filter((e) => e.name === 'typing');

// Spec 022: the "is typing" notice of a direct chat. The server only relays it to the other person, and only
// while that person has the conversation open; it is never saved and it never carries text.
describe('typing notice (spec 022)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterEach(() => closeAllChatClients());
  afterAll(() => ctx.close());

  async function direct() {
    const world = await chatWorld(ctx);
    const conversation = await directWith(world.student, world.teacher);
    const [mine, theirs] = [await connectChat(ctx, world.student.token), await connectChat(ctx, world.teacher.token)];
    return { ...world, conversation, mine, theirs };
  }

  it('reaches the other person of a direct chat when they have it open, and never the sender', async () => {
    const { student, conversation, mine, theirs } = await direct();
    await theirs.emitWithAck('conversation:open', { conversationId: conversation.id });
    await mine.emitWithAck('conversation:open', { conversationId: conversation.id });

    expect(await mine.emitWithAck('typing', { conversationId: conversation.id })).toEqual({ ok: true });
    expect(await theirs.waitFor('typing')).toEqual({ conversationId: conversation.id, userId: student.user.id });
    await pause(200);
    expect(typingOf(mine)).toHaveLength(0);
  });

  it('does not reach the other person when they do not have that conversation open', async () => {
    const { conversation, mine, theirs } = await direct();
    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await pause(300);
    expect(typingOf(theirs)).toHaveLength(0);
    await theirs.emitWithAck('conversation:open', { conversationId: conversation.id });
    await theirs.emitWithAck('conversation:close', { conversationId: conversation.id });
    ctx.clock.advance(2_100);
    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await pause(300);
    expect(typingOf(theirs)).toHaveLength(0);
  });

  it('never reaches a third person, not even another student of the same module', async () => {
    const { module, conversation, mine, theirs } = await direct();
    const { student: stranger } = await enrollAnother(ctx, module.id);
    const outsider = await connectChat(ctx, stranger.token);
    await theirs.emitWithAck('conversation:open', { conversationId: conversation.id });
    expect(await outsider.emitWithAck('conversation:open', { conversationId: conversation.id })).toEqual({ ok: false, code: 'CHAT_NOT_FOUND' });

    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await theirs.waitFor('typing');
    expect(typingOf(outsider)).toHaveLength(0);
  });

  it('does nothing for someone who has no access to the conversation, and answers ok so it reveals nothing', async () => {
    const { module, conversation, theirs } = await direct();
    const { student: stranger } = await enrollAnother(ctx, module.id);
    const outsider = await connectChat(ctx, stranger.token);
    await theirs.emitWithAck('conversation:open', { conversationId: conversation.id });

    expect(await outsider.emitWithAck('typing', { conversationId: conversation.id })).toEqual({ ok: true });
    expect(await outsider.emitWithAck('typing', { conversationId: 'not-a-uuid' })).toEqual({ ok: true });
    expect(await outsider.emitWithAck('typing', {})).toEqual({ ok: true });
    await pause(300);
    expect(typingOf(theirs)).toHaveLength(0);
  });

  it('never relays it in a module chat', async () => {
    const { module, student, teacher } = await chatWorld(ctx);
    const group = await moduleChatOf(teacher, module.id);
    const [mine, theirs] = [await connectChat(ctx, student.token), await connectChat(ctx, teacher.token)];
    for (const client of [mine, theirs]) await client.emitWithAck('conversation:open', { conversationId: group });

    expect(await mine.emitWithAck('typing', { conversationId: group })).toEqual({ ok: true });
    await pause(300);
    expect(typingOf(theirs)).toHaveLength(0);
    expect(typingOf(mine)).toHaveLength(0);
  });

  it('ignores a notice within 2 seconds of the previous one from the same socket, and relays it after', async () => {
    const { conversation, mine, theirs } = await direct();
    await theirs.emitWithAck('conversation:open', { conversationId: conversation.id });
    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await pause(300);
    expect(typingOf(theirs)).toHaveLength(1);

    ctx.clock.advance(2_100);
    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await pause(300);
    expect(typingOf(theirs)).toHaveLength(2);
  });

  it('does not relay it when the conversation is read only', async () => {
    const { period, conversation, mine, theirs } = await direct();
    await theirs.emitWithAck('conversation:open', { conversationId: conversation.id });
    await ctx.prisma.academicPeriod.update({ where: { id: period.id }, data: { status: 'CLOSED' } });

    await mine.emitWithAck('typing', { conversationId: conversation.id });
    await pause(300);
    expect(typingOf(theirs)).toHaveLength(0);
  });
});
