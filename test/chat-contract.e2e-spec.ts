import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createChatMessage } from './utils/chat.js';
import { chatWorld, directWith, messageBody, moduleChatOf } from './utils/chat-world.js';
import { loadContract, specPath } from './utils/contract.js';
import { studentCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('018-chat/contracts/chat-api.yaml'));
const NOBODY = '00000000-0000-4000-8000-000000000999';

// Real answers of the 8 endpoints against specs/018-chat/contracts/chat-api.yaml.
describe.skipIf(!contract.available)('responses match chat-api.yaml', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const check = <T extends { status: number; body: unknown }>(res: T, method: string, path: string, schema: string): T => {
    contract.assertDocumented(method, path, res.status);
    contract.assertMatchesSchema(schema, res.body);
    return res;
  };

  it('contacts, open, list, detail, history, send, read and unread', async () => {
    const { student, teacher, module } = await chatWorld(ctx);
    check(await student.get('/chat/contacts'), 'get', '/chat/contacts', 'ContactList');

    const created = check(await student.post('/chat/conversations', { userId: teacher.user.id }), 'post', '/chat/conversations', 'ConversationDetail');
    check(await student.post('/chat/conversations', { userId: teacher.user.id }), 'post', '/chat/conversations', 'ConversationDetail');
    check(await student.post('/chat/conversations', { userId: 'nope' }), 'post', '/chat/conversations', 'Error');
    const classmate = await studentCaller(ctx);
    check(await student.post('/chat/conversations', { userId: classmate.user.id }), 'post', '/chat/conversations', 'Error');
    const id = created.body.id as string;

    check(await student.get(`/chat/conversations/${id}`), 'get', '/chat/conversations/{id}', 'ConversationDetail');
    check(await student.get(`/chat/conversations/${NOBODY}`), 'get', '/chat/conversations/{id}', 'Error');

    const body = messageBody();
    check(await student.post(`/chat/conversations/${id}/messages`, body), 'post', '/chat/conversations/{id}/messages', 'Message');
    check(await student.post(`/chat/conversations/${id}/messages`, body), 'post', '/chat/conversations/{id}/messages', 'Message');
    check(await student.post(`/chat/conversations/${id}/messages`, messageBody({ body: '' })), 'post', '/chat/conversations/{id}/messages', 'Error');
    check(await student.post(`/chat/conversations/${NOBODY}/messages`, messageBody()), 'post', '/chat/conversations/{id}/messages', 'Error');
    check(await student.post(`/chat/conversations/${id}/messages`, messageBody({ kind: 'ANNOUNCEMENT' })), 'post', '/chat/conversations/{id}/messages', 'Error');

    for (let i = 0; i < 3; i += 1) await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id });
    check(await student.get('/chat/conversations'), 'get', '/chat/conversations', 'ConversationList');
    const page = check(await student.get(`/chat/conversations/${id}/messages?limit=2`), 'get', '/chat/conversations/{id}/messages', 'MessagePage');
    expect(page.body.next).not.toBeNull();
    check(await student.get(`/chat/conversations/${id}/messages?before=${page.body.next}`), 'get', '/chat/conversations/{id}/messages', 'MessagePage');
    check(await student.get(`/chat/conversations/${id}/messages?limit=0`), 'get', '/chat/conversations/{id}/messages', 'Error');
    check(await student.get(`/chat/conversations/${NOBODY}/messages`), 'get', '/chat/conversations/{id}/messages', 'Error');

    check(await student.get('/chat/unread-count'), 'get', '/chat/unread-count', 'UnreadCount');
    check(await student.post(`/chat/conversations/${id}/read`), 'post', '/chat/conversations/{id}/read', 'UnreadCount');
    check(await student.post(`/chat/conversations/${NOBODY}/read`), 'post', '/chat/conversations/{id}/read', 'Error');

    const group = await moduleChatOf(teacher, module.id);
    check(await teacher.get(`/chat/conversations/${group}`), 'get', '/chat/conversations/{id}', 'ConversationDetail');
    check(await teacher.post(`/chat/conversations/${group}/messages`, messageBody({ kind: 'ANNOUNCEMENT' })), 'post', '/chat/conversations/{id}/messages', 'Message');
  });

  it('read-only answers 409 with the reason, and a missing session answers 401', async () => {
    const { student, teacher, enrollment } = await chatWorld(ctx);
    const { id } = await directWith(student, teacher);
    await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), effectiveUntil: new Date() } });
    const refused = check(await student.post(`/chat/conversations/${id}/messages`, messageBody()), 'post', '/chat/conversations/{id}/messages', 'Error');
    expect(refused.body.details.reason).toBe('NO_SHARED_MODULE');
    check(await ctx.http().get('/api/v1/chat/unread-count'), 'get', '/chat/unread-count', 'Error');
  });
});
