import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatWorld, directWith, messageBody, sendTo } from './utils/chat-world.js';
import { createEnrollment, createStudent, createTeacher } from './utils/factories.js';
import { moduleWithSessions } from './utils/enrollment.js';
import { studentCaller, teacherCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('direct chat (spec 018, story 1)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  describe('contacts', () => {
    it('shows a student only the teachers of the modules where they are enrolled, with the module names', async () => {
      const { student, teacher, period } = await chatWorld(ctx);
      const other = await teacherCaller(ctx);
      await moduleWithSessions(ctx, period.id, { teacherId: other.user.id });
      const res = await student.get('/chat/contacts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([expect.objectContaining({ id: teacher.user.id, role: 'TEACHER', modules: ['Cálculo I'] })]);
    });

    it('shows a teacher the students enrolled in their modules and the CAE', async () => {
      const { teacher, student, cae } = await chatWorld(ctx);
      const stranger = await studentCaller(ctx);
      const res = await teacher.get('/chat/contacts');
      const ids = res.body.map((c: { id: string }) => c.id);
      expect(ids).toContain(student.user.id);
      expect(ids).toContain(cae.user.id);
      expect(ids).not.toContain(stranger.user.id);
    });

    it('shows the CAE the active teachers only, and the search ignores accents and case', async () => {
      const { cae, teacher } = await chatWorld(ctx);
      const jose = await createTeacher(ctx.prisma, { firstName: 'José', lastName: 'Núñez' });
      await createTeacher(ctx.prisma, { firstName: 'Inactivo', status: 'INACTIVE' });
      await createTeacher(ctx.prisma, { firstName: 'Borrado', deletedAt: new Date() });
      const all = (await cae.get('/chat/contacts')).body.map((c: { id: string }) => c.id);
      expect(all).toContain(teacher.user.id);
      expect(all).toContain(jose.id);
      expect(all).toHaveLength(2);
      const found = await cae.get('/chat/contacts?search=JOSE%20nunez');
      expect(found.body.map((c: { id: string }) => c.id)).toEqual([jose.id]);
    });

    it('drops the students whose enrollment was cancelled or whose period is closed', async () => {
      const { teacher, student, enrollment, period } = await chatWorld(ctx);
      await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), effectiveUntil: new Date() } });
      expect((await teacher.get('/chat/contacts')).body.map((c: { id: string }) => c.id)).not.toContain(student.user.id);
      await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'ACTIVE', cancelledAt: null, effectiveUntil: null } });
      await ctx.prisma.academicPeriod.update({ where: { id: period.id }, data: { status: 'CLOSED' } });
      expect((await teacher.get('/chat/contacts')).body.map((c: { id: string }) => c.id)).not.toContain(student.user.id);
    });
  });

  describe('opening a conversation', () => {
    it('creates it once and returns the same one from either side', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const first = await student.post('/chat/conversations', { userId: teacher.user.id });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ type: 'DIRECT', canWrite: true, readOnlyReason: null, canAnnounce: false, unread: 0, lastMessage: null });
      expect(first.body.partner).toMatchObject({ id: teacher.user.id, role: 'TEACHER' });
      const again = await student.post('/chat/conversations', { userId: teacher.user.id });
      const fromTeacher = await teacher.post('/chat/conversations', { userId: student.user.id });
      expect(again.status).toBe(200);
      expect(fromTeacher.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(fromTeacher.body.id).toBe(first.body.id);
      expect(await ctx.prisma.conversationMember.count({ where: { conversationId: first.body.id } })).toBe(2);
      expect(await ctx.prisma.conversation.count()).toBe(1);
    });

    it('lets the CAE and a teacher talk without sharing any module', async () => {
      const { cae, teacher } = await chatWorld(ctx);
      const res = await cae.post('/chat/conversations', { userId: teacher.user.id });
      expect(res.status).toBe(201);
      expect(res.body.canWrite).toBe(true);
    });

    it('answers 403 CHAT_PARTNER_NOT_ALLOWED to a pair that cannot chat', async () => {
      const { student, teacher, cae, period } = await chatWorld(ctx);
      const classmate = await studentCaller(ctx);
      const stranger = await teacherCaller(ctx);
      const unrelated = await createStudent(ctx.prisma);
      await moduleWithSessions(ctx, period.id, { teacherId: stranger.user.id });
      const tries = [
        [student, classmate.user.id],
        [student, cae.user.id],
        [student, stranger.user.id],
        [student, student.user.id],
        [student, crypto.randomUUID()],
        [teacher, unrelated.id],
        [teacher, teacher.user.id],
        [cae, student.user.id],
      ] as const;
      for (const [who, userId] of tries) {
        const res = await who.post('/chat/conversations', { userId });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('CHAT_PARTNER_NOT_ALLOWED');
      }
      expect(await ctx.prisma.conversation.count()).toBe(0);
    });

    it('rejects a body without a valid user id', async () => {
      const { student } = await chatWorld(ctx);
      expect((await student.post('/chat/conversations', { userId: 'nope' })).status).toBe(400);
      expect((await student.post('/chat/conversations', {})).status).toBe(400);
    });

    it('shows a conversation only to its two members', async () => {
      const { student, teacher, cae } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      expect((await teacher.get(`/chat/conversations/${id}`)).status).toBe(200);
      for (const outsider of [cae, await studentCaller(ctx), await teacherCaller(ctx)]) {
        const res = await outsider.get(`/chat/conversations/${id}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('CHAT_NOT_FOUND');
      }
      expect((await student.get(`/chat/conversations/${crypto.randomUUID()}`)).status).toBe(404);
    });
  });

  describe('sending', () => {
    it('saves a message with its sender, kind TEXT and the date in UTC, trimming the spaces', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const res = await sendTo(student, id, { body: '  Hola profe  ' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ conversationId: id, kind: 'TEXT', body: 'Hola profe', sender: { id: student.user.id, role: 'STUDENT' } });
      expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
      const conversation = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id } });
      expect(conversation.lastMessageAt?.toISOString()).toBe(res.body.createdAt);
    });

    it('answers 400 VALIDATION_FAILED naming the field for an empty, blank or too long body or a bad key', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      for (const [change, field] of [
        [{ body: '' }, 'body'],
        [{ body: '   \n ' }, 'body'],
        [{ body: 'a'.repeat(2001) }, 'body'],
        [{ clientMessageId: 'nope' }, 'clientMessageId'],
        [{ kind: 'SHOUT' }, 'kind'],
      ] as const) {
        const res = await sendTo(student, id, change);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.details.fields).toHaveProperty(field);
      }
      expect((await sendTo(student, id, { body: 'a'.repeat(2000) })).status).toBe(201);
      expect(await ctx.prisma.message.count()).toBe(1);
    });

    it('follows the length limit stored in settings and shows it in the conversation', async () => {
      const { student, teacher } = await chatWorld(ctx);
      await ctx.prisma.setting.create({ data: { key: 'chat.messageMaxLength', value: 10 } });
      const conversation = await student.post('/chat/conversations', { userId: teacher.user.id });
      expect(conversation.body.limits).toEqual({ messageMaxLength: 10 });
      expect((await sendTo(student, conversation.body.id, { body: 'a'.repeat(11) })).status).toBe(400);
      expect((await sendTo(student, conversation.body.id, { body: 'a'.repeat(10) })).status).toBe(201);
    });

    it('returns the same message with 200 for a retry and saves only one, also when two arrive at once', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const body = messageBody();
      const first = await student.post(`/chat/conversations/${id}/messages`, body);
      const again = await student.post(`/chat/conversations/${id}/messages`, body);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      const race = messageBody();
      const both = await Promise.all([student.post(`/chat/conversations/${id}/messages`, race), student.post(`/chat/conversations/${id}/messages`, race)]);
      expect(both.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 201]);
      expect(await ctx.prisma.message.count()).toBe(2);
    });

    it('lets the teacher answer and keeps one conversation', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      await sendTo(student, id);
      const answer = await sendTo(teacher, id, { body: 'Claro, dime' });
      expect(answer.status).toBe(201);
      expect(answer.body.sender.role).toBe('TEACHER');
    });

    it('is not allowed to announce in a direct chat', async () => {
      const { teacher, student } = await chatWorld(ctx);
      const { id } = await directWith(teacher, student);
      const res = await sendTo(teacher, id, { kind: 'ANNOUNCEMENT' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CHAT_ANNOUNCEMENT_FORBIDDEN');
    });

    it('does not let an outsider write into a conversation that is not theirs', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      const outsider = await studentCaller(ctx);
      const res = await sendTo(outsider, id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CHAT_NOT_FOUND');
    });
  });

  describe('read-only conversations', () => {
    it('turns read-only for both when the student stops sharing a module, keeping the history readable', async () => {
      const { student, teacher, enrollment } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      await sendTo(student, id, { body: 'Antes de la baja' });
      await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), effectiveUntil: new Date() } });
      for (const who of [student, teacher]) {
        const res = await sendTo(who, id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CHAT_READ_ONLY');
        expect(res.body.details).toEqual({ reason: 'NO_SHARED_MODULE' });
        const detail = await who.get(`/chat/conversations/${id}`);
        expect(detail.body).toMatchObject({ canWrite: false, readOnlyReason: 'NO_SHARED_MODULE' });
        expect((await who.get(`/chat/conversations/${id}/messages`)).body.data).toHaveLength(1);
      }
    });

    it('writes again when they share a module again, and a closed period also counts as not sharing', async () => {
      const { student, teacher, period, module } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      await ctx.prisma.academicPeriod.update({ where: { id: period.id }, data: { status: 'CLOSED' } });
      expect((await sendTo(student, id)).body.details).toEqual({ reason: 'NO_SHARED_MODULE' });
      await ctx.prisma.academicPeriod.update({ where: { id: period.id }, data: { status: 'ACTIVE' } });
      expect((await sendTo(student, id)).status).toBe(201);
      await ctx.prisma.module.update({ where: { id: module.id }, data: { deletedAt: new Date() } });
      expect((await sendTo(student, id)).body.details).toEqual({ reason: 'NO_SHARED_MODULE' });
    });

    it.each([
      ['deactivated', { status: 'INACTIVE' as const }],
      ['deleted', { deletedAt: new Date() }],
    ])('is read-only for the other person when their account is %s', async (_name, change) => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      await sendTo(student, id);
      await ctx.prisma.user.update({ where: { id: teacher.user.id }, data: change });
      const res = await sendTo(student, id);
      expect(res.status).toBe(409);
      expect(res.body.details).toEqual({ reason: 'PARTNER_UNAVAILABLE' });
      expect((await student.get(`/chat/conversations/${id}`)).body).toMatchObject({ canWrite: false, readOnlyReason: 'PARTNER_UNAVAILABLE' });
      expect((await student.get(`/chat/conversations/${id}/messages`)).body.data).toHaveLength(1);
    });

    it('does not let a deactivated account write at all', async () => {
      const { student, teacher } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      await ctx.prisma.user.update({ where: { id: student.user.id }, data: { status: 'INACTIVE' } });
      expect((await sendTo(student, id)).status).toBe(401);
    });

    it('lets an existing conversation be reopened as read-only but not created for a pair that no longer shares a module', async () => {
      const { student, teacher, enrollment } = await chatWorld(ctx);
      const { id } = await directWith(student, teacher);
      await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), effectiveUntil: new Date() } });
      const reopen = await student.post('/chat/conversations', { userId: teacher.user.id });
      expect(reopen.status).toBe(200);
      expect(reopen.body.id).toBe(id);
      expect(reopen.body.canWrite).toBe(false);
      const other = await studentCaller(ctx);
      await createEnrollment(ctx.prisma, { studentId: other.user.id, moduleId: enrollment.moduleId, status: 'CANCELLED' });
      expect((await other.post('/chat/conversations', { userId: teacher.user.id })).status).toBe(403);
    });
  });
});
