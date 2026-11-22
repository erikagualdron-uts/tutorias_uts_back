import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatWorld, directWith, moduleChatOf, sendTo } from './utils/chat-world.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

type Method = 'get' | 'post';
// Every route of contracts/chat-api.yaml: all of them need a session, with any of the three roles.
const ROUTES: [Method, string][] = [
  ['get', '/chat/contacts'],
  ['get', '/chat/conversations'],
  ['post', '/chat/conversations'],
  ['get', '/chat/conversations/:id'],
  ['get', '/chat/conversations/:id/messages'],
  ['post', '/chat/conversations/:id/messages'],
  ['post', '/chat/conversations/:id/read'],
  ['get', '/chat/unread-count'],
];

describe('chat routes need a session and never reveal a conversation (spec 018)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it.each(ROUTES)('%s %s answers 401 without a session', async (method, path) => {
    const res = await ctx.http()[method](`/api/v1${path.replace(':id', crypto.randomUUID())}`).send({});
    expect(res.status).toBe(401);
  });

  it('answers the three roles on the routes that list', async () => {
    const { student, teacher, cae } = await chatWorld(ctx);
    for (const who of [student, teacher, cae]) {
      for (const path of ['/chat/contacts', '/chat/conversations', '/chat/unread-count']) {
        expect((await who.get(path)).status).toBe(200);
      }
    }
  });

  it('answers 404 CHAT_NOT_FOUND, never 403, to anyone asking for a conversation that is not theirs', async () => {
    const { student, teacher, cae, module } = await chatWorld(ctx);
    const direct = await directWith(student, teacher);
    const group = await moduleChatOf(teacher, module.id);
    for (const [who, id] of [
      [cae, direct.id],
      [cae, group],
    ] as const) {
      for (const [method, path] of [
        ['get', `/chat/conversations/${id}`],
        ['get', `/chat/conversations/${id}/messages`],
        ['post', `/chat/conversations/${id}/read`],
      ] as const) {
        const res = await who[method](path);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('CHAT_NOT_FOUND');
      }
      const sent = await sendTo(who, id);
      expect(sent.status).toBe(404);
      expect(sent.body.code).toBe('CHAT_NOT_FOUND');
    }
  });

  it('answers 400 to an id that is not a uuid', async () => {
    const { student } = await chatWorld(ctx);
    expect((await student.get('/chat/conversations/not-a-uuid')).status).toBe(400);
    expect((await student.get('/chat/conversations/not-a-uuid/messages')).status).toBe(400);
  });
});
