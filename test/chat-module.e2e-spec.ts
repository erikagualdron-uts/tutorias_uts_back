import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllChatClients, connectChat, createChatMessage } from './utils/chat.js';
import { chatWorld, enrollAnother, moduleChatOf, sendTo } from './utils/chat-world.js';
import { moduleWithSessions } from './utils/enrollment.js';
import { studentCaller, teacherCaller, type Caller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('module chat and announcements (spec 018, story 5)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterEach(() => closeAllChatClients());
  afterAll(() => ctx.close());

  const register = (who: Caller, token: string) =>
    ctx.http().put('/api/v1/notifications/devices').set('Authorization', `Bearer ${who.token}`).send({ token, platform: 'ANDROID' }).expect(204);

  describe('listing and access', () => {
    it('lists the chat of each module of the teacher and of each enrolled student, also without messages, once', async () => {
      const { teacher, student, cae, module } = await chatWorld(ctx);
      for (const who of [teacher, student]) {
        const first = (await who.get('/chat/conversations')).body;
        const second = (await who.get('/chat/conversations')).body;
        expect(first).toEqual([expect.objectContaining({ type: 'MODULE', module: { id: module.id, name: 'Cálculo I' }, unread: 0, lastMessage: null, lastMessageAt: null, partner: null })]);
        expect(second[0].id).toBe(first[0].id);
      }
      expect((await cae.get('/chat/conversations')).body).toEqual([]);
      expect(await ctx.prisma.conversation.count({ where: { type: 'MODULE' } })).toBe(1);
    });

    it('does not exist for a student who is not enrolled, another teacher or the CAE', async () => {
      const { teacher, cae, module } = await chatWorld(ctx);
      const id = await moduleChatOf(teacher, module.id);
      for (const outsider of [await studentCaller(ctx), await teacherCaller(ctx), cae]) {
        for (const res of [await outsider.get(`/chat/conversations/${id}`), await outsider.get(`/chat/conversations/${id}/messages`), await sendTo(outsider, id)]) {
          expect(res.status).toBe(404);
          expect(res.body.code).toBe('CHAT_NOT_FOUND');
        }
      }
    });

    it('lets everyone in write a normal message and tells who can announce', async () => {
      const { teacher, student, module } = await chatWorld(ctx);
      const { student: classmate } = await enrollAnother(ctx, module.id);
      const id = await moduleChatOf(teacher, module.id);
      expect((await teacher.get(`/chat/conversations/${id}`)).body).toMatchObject({ canWrite: true, canAnnounce: true });
      expect((await student.get(`/chat/conversations/${id}`)).body).toMatchObject({ canWrite: true, canAnnounce: false });
      const written = await sendTo(student, id, { body: 'Una duda para el grupo' });
      expect(written.status).toBe(201);
      expect(written.body.kind).toBe('TEXT');
      for (const who of [teacher, classmate]) {
        expect((await who.get(`/chat/conversations/${id}/messages`)).body.data.map((m: { id: string }) => m.id)).toContain(written.body.id);
      }
    });
  });

  describe('announcements', () => {
    it('lets the teacher of the module announce and refuses a student', async () => {
      const { teacher, student, module } = await chatWorld(ctx);
      const id = await moduleChatOf(teacher, module.id);
      const announced = await sendTo(teacher, id, { kind: 'ANNOUNCEMENT', body: 'Mañana no hay clase' });
      expect(announced.status).toBe(201);
      expect(announced.body).toMatchObject({ kind: 'ANNOUNCEMENT', sender: { id: teacher.user.id, role: 'TEACHER' } });
      const refused = await sendTo(student, id, { kind: 'ANNOUNCEMENT' });
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('CHAT_ANNOUNCEMENT_FORBIDDEN');
      expect((await student.get(`/chat/conversations/${id}/messages`)).body.data[0]).toMatchObject({ id: announced.body.id, kind: 'ANNOUNCEMENT' });
    });

    it('does not let a teacher of another module announce in this one', async () => {
      const { teacher, period, module } = await chatWorld(ctx);
      const other = await teacherCaller(ctx);
      await moduleWithSessions(ctx, period.id, { teacherId: other.user.id });
      const id = await moduleChatOf(teacher, module.id);
      expect((await sendTo(other, id, { kind: 'ANNOUNCEMENT' })).status).toBe(404);
    });
  });

  describe('who sees what', () => {
    it('hides what was written while the student was not enrolled, and the chat itself after the baja', async () => {
      const { teacher, student, enrollment, module } = await chatWorld(ctx);
      const id = await moduleChatOf(teacher, module.id);
      await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { createdAt: minutesAgo(50) } });
      const before = await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id, body: 'A antes', createdAt: minutesAgo(60) });
      const inFirst = await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id, body: 'B dentro', createdAt: minutesAgo(40) });
      await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'CANCELLED', cancelledAt: minutesAgo(30), effectiveUntil: minutesAgo(30) } });
      const gap = await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id, body: 'C hueco', createdAt: minutesAgo(20) });

      // after the baja the chat does not exist for the student
      expect((await student.get('/chat/conversations')).body).toEqual([]);
      expect((await student.get(`/chat/conversations/${id}`)).status).toBe(404);
      expect((await student.get(`/chat/conversations/${id}/messages`)).status).toBe(404);
      expect((await sendTo(student, id)).status).toBe(404);
      expect((await student.get('/chat/unread-count')).body).toEqual({ unread: 0 });

      // enrolled again: the first window and the new one show, the gap does not
      await ctx.prisma.enrollment.create({ data: { studentId: student.user.id, moduleId: module.id, createdAt: minutesAgo(10) } });
      const last = await createChatMessage(ctx.prisma, { conversationId: id, senderId: teacher.user.id, body: 'D nuevo', createdAt: minutesAgo(5) });
      const seen = (await student.get(`/chat/conversations/${id}/messages`)).body.data.map((m: { id: string }) => m.id);
      expect(seen).toEqual([last.id, inFirst.id]);
      expect(seen).not.toContain(before.id);
      expect(seen).not.toContain(gap.id);
      expect((await student.get('/chat/unread-count')).body).toEqual({ unread: 2 });
      const [listed] = (await student.get('/chat/conversations')).body;
      expect(listed).toMatchObject({ unread: 2, lastMessage: { id: last.id } });
      expect((await teacher.get(`/chat/conversations/${id}/messages`)).body.data).toHaveLength(4);
    });

    it('is read-only for everyone once the period is closed, and nobody can announce', async () => {
      const { teacher, student, period, module } = await chatWorld(ctx);
      const id = await moduleChatOf(teacher, module.id);
      await sendTo(teacher, id, { body: 'Antes de cerrar' });
      await ctx.prisma.academicPeriod.update({ where: { id: period.id }, data: { status: 'CLOSED' } });
      for (const who of [teacher, student]) {
        const detail = await who.get(`/chat/conversations/${id}`);
        expect(detail.body).toMatchObject({ canWrite: false, readOnlyReason: 'PERIOD_CLOSED', canAnnounce: false });
        const refused = await sendTo(who, id);
        expect(refused.status).toBe(409);
        expect(refused.body.details).toEqual({ reason: 'PERIOD_CLOSED' });
        expect((await who.get(`/chat/conversations/${id}/messages`)).body.data).toHaveLength(1);
      }
      expect((await sendTo(teacher, id, { kind: 'ANNOUNCEMENT' })).status).toBe(409);
    });
  });

  describe('realtime and push', () => {
    it('reaches the teacher and the active students of that module only', async () => {
      const { teacher, student, module, period } = await chatWorld(ctx);
      const { student: classmate } = await enrollAnother(ctx, module.id);
      const { student: inactive } = await enrollAnother(ctx, module.id);
      const outsider = await studentCaller(ctx);
      const otherTeacher = await teacherCaller(ctx);
      const { module: other } = await moduleWithSessions(ctx, period.id, { teacherId: otherTeacher.user.id });
      await ctx.prisma.enrollment.create({ data: { studentId: outsider.user.id, moduleId: other.id } });
      await ctx.prisma.user.update({ where: { id: inactive.user.id }, data: { status: 'INACTIVE' } });
      const id = await moduleChatOf(teacher, module.id);

      const writer = await connectChat(ctx, teacher.token);
      const mate = await connectChat(ctx, classmate.token);
      const me = await connectChat(ctx, student.token);
      const stranger = await connectChat(ctx, outsider.token);
      const sent = await sendTo(teacher, id, { kind: 'ANNOUNCEMENT', body: 'Aviso para todos' });

      for (const client of [writer, mate, me]) expect(await client.waitFor('message:new')).toMatchObject({ id: sent.body.id, kind: 'ANNOUNCEMENT' });
      await pause(300);
      expect(stranger.events.filter((e) => e.name === 'message:new')).toHaveLength(0);
      expect(await mate.waitFor('unread:changed')).toEqual({ unread: 1 });
    });

    it('pushes announcements to the enrolled students in their language, not normal messages and not the writer', async () => {
      const { teacher, student, module } = await chatWorld(ctx);
      const { student: english } = await enrollAnother(ctx, module.id);
      await ctx.prisma.user.update({ where: { id: english.user.id }, data: { locale: 'en' } });
      await register(student, 'ExponentPushToken[mod-es]');
      await register(english, 'ExponentPushToken[mod-en]');
      await register(teacher, 'ExponentPushToken[mod-teacher]');
      const id = await moduleChatOf(teacher, module.id);

      await sendTo(student, id, { body: 'mensaje normal del grupo' });
      await pause(400);
      expect(ctx.push.sent).toHaveLength(0);

      await sendTo(teacher, id, { kind: 'ANNOUNCEMENT', body: 'Traigan calculadora' });
      await vi.waitFor(() => expect(ctx.push.sent).toHaveLength(2));
      expect(ctx.push.to('ExponentPushToken[mod-es]')[0]).toMatchObject({ title: 'Anuncio · Cálculo I', body: 'Traigan calculadora', data: { conversationId: id } });
      expect(ctx.push.to('ExponentPushToken[mod-en]')[0].title).toBe('Announcement · Cálculo I');
      expect(ctx.push.to('ExponentPushToken[mod-teacher]')).toHaveLength(0);
    });

    it('does not push an announcement to a student who has the chat open', async () => {
      const { teacher, student, module } = await chatWorld(ctx);
      await register(student, 'ExponentPushToken[mod-open]');
      const id = await moduleChatOf(teacher, module.id);
      const open = await connectChat(ctx, student.token);
      expect(await open.emitWithAck('conversation:open', { conversationId: id })).toEqual({ ok: true });
      await sendTo(teacher, id, { kind: 'ANNOUNCEMENT' });
      await pause(400);
      expect(ctx.push.sent).toHaveLength(0);
    });
  });
});
