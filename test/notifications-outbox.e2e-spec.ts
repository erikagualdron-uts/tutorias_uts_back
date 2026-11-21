import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAbsence,
  createEnrollment,
  createLocation,
  createOutboxEvent,
  createRoom,
  createStudent,
  createTeacher,
} from './utils/factories.js';
import { teacherApi } from './utils/teacher.js';
import { HOUR, seriesModule, start, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// Events of the outbox become one notice per student who attends (specs 010 and 012 write them).
describe('notifications: from events to notices', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const wednesday = (n = 0) => week(n, 19, 1);

  async function scenario() {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id, { name: 'Cálculo I' });
    const enroll = async (locale: 'es' | 'en' = 'es') => {
      const student = await createStudent(ctx.prisma, { locale });
      const enrollment = await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      return { student, enrollment };
    };
    return { m, enroll, api: teacherApi(ctx, m.teacher) };
  }
  const noticesOf = (userId: string) => ctx.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

  it('notices an enrolled student when the teacher reschedules a session (story 1, scenario 1)', async () => {
    const { m, enroll, api } = await scenario();
    const { student } = await enroll();
    await api.reschedule(m.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() }).expect(200);

    expect(await ctx.runOutbox()).toBe(1);

    const [notice] = await noticesOf(student.id);
    expect(notice).toMatchObject({ type: 'SESSION_RESCHEDULED', moduleId: m.module.id, locale: 'es', readAt: null });
    expect(notice.title).toBe('Cambió la hora de tu tutoría');
    expect(notice.body).toContain('Cálculo I');
    expect(notice.body).toMatch(/martes.*8 de enero.*2:00\s*p\.\s*m\./i);
    expect(notice.body).toMatch(/miércoles.*9 de enero.*2:00\s*p\.\s*m\./i);
  });

  it('notices on a cancellation of one session and of the series, with the scope (scenario 2)', async () => {
    const { m, enroll, api } = await scenario();
    const { student } = await enroll();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await api.cancel(m.sessions[0][1].id, { scope: 'SERIES' }).expect(200);
    await ctx.runOutbox();

    const [one, series] = await noticesOf(student.id);
    expect(one.type).toBe('SESSION_CANCELLED_TEACHER');
    expect(one.body).toContain('Solo afecta a esa sesión');
    expect(series.body).toContain('3 sesiones');
    expect(series.body).toContain('siguientes');
  });

  it('notices when the teacher restores a cancelled session (scenario 3)', async () => {
    const { m, enroll, api } = await scenario();
    const { student } = await enroll();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await api.restore(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    const notices = await noticesOf(student.id);
    expect(notices.map((n) => n.type).sort()).toEqual(['SESSION_CANCELLED_TEACHER', 'SESSION_RESTORED_TEACHER']);
    expect(notices.find((n) => n.type === 'SESSION_RESTORED_TEACHER')?.title).toBe('Tu tutoría vuelve a darse');
  });

  it('names the new teacher when the CAE changes it (scenario 4)', async () => {
    const { m, enroll } = await scenario();
    const { student } = await enroll();
    const next = await createTeacher(ctx.prisma, { firstName: 'Ana', lastName: 'Gómez' });
    await createOutboxEvent(ctx.prisma, {
      type: 'MODULE_TEACHER_CHANGED',
      moduleId: m.module.id,
      payload: { fromTeacherId: m.teacher.user.id, toTeacherId: next.id, enrolled: 1 },
    });
    await ctx.runOutbox();
    const [notice] = await noticesOf(student.id);
    expect(notice.title).toBe('Cambió el docente de tu módulo');
    expect(notice.body).toContain('Ana Gómez');
  });

  it('names the new room when the CAE changes it (scenario 4)', async () => {
    const { m, enroll } = await scenario();
    const { student } = await enroll('en');
    const location = await createLocation(ctx.prisma, { name: 'Sede Principal' });
    const room = await createRoom(ctx.prisma, { name: 'Sala 204', locationId: location.id });
    await createOutboxEvent(ctx.prisma, {
      type: 'MODULE_ROOM_CHANGED',
      moduleId: m.module.id,
      payload: { fromRoomId: m.room.id, toRoomId: room.id, enrolled: 1 },
    });
    await ctx.runOutbox();
    const [notice] = await noticesOf(student.id);
    expect(notice.title).toBe('The room of your module changed');
    expect(notice.body).toContain('Sala 204 (Sede Principal)');
  });

  it('gives the holiday reason when a holiday cancels or restores a session (scenario 5)', async () => {
    const { m, enroll } = await scenario();
    const { student } = await enroll();
    await createOutboxEvent(ctx.prisma, {
      type: 'SESSIONS_CANCELLED_HOLIDAY',
      moduleId: m.module.id,
      payload: { date: '2030-01-08', sessions: 1 },
    });
    await createOutboxEvent(ctx.prisma, {
      type: 'SESSIONS_RESTORED_HOLIDAY',
      moduleId: m.module.id,
      payload: { date: '2030-01-08', restored: 1, generated: 0 },
    });
    await ctx.runOutbox();
    const notices = await noticesOf(student.id);
    expect(notices).toHaveLength(2);
    expect(notices[0].body).toContain('festivo');
    expect(notices[0].body).toMatch(/martes.*8 de enero/i);
    expect(notices[1].body).toContain('ya no es festivo');
  });

  it('sends nothing to a student who is not enrolled or who already left (scenario 6)', async () => {
    const { m, enroll, api } = await scenario();
    const stranger = await createStudent(ctx.prisma);
    const left = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, {
      studentId: left.id,
      moduleId: m.module.id,
      status: 'CANCELLED',
      effectiveUntil: new Date(week(0).getTime() - HOUR),
    });
    const { student } = await enroll();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    expect(await noticesOf(student.id)).toHaveLength(1);
    expect(await noticesOf(stranger.id)).toHaveLength(0);
    expect(await noticesOf(left.id)).toHaveLength(0);
  });

  it('writes each notice in the language of its student, in Bogota time (scenario 7)', async () => {
    const { m, enroll, api } = await scenario();
    const spanish = await enroll('es');
    const english = await enroll('en');
    await api.reschedule(m.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() }).expect(200);
    await ctx.runOutbox();
    const [es] = await noticesOf(spanish.student.id);
    const [en] = await noticesOf(english.student.id);
    expect(es).toMatchObject({ locale: 'es', title: 'Cambió la hora de tu tutoría' });
    expect(en).toMatchObject({ locale: 'en', title: 'The time of your session changed' });
    expect(en.body).toMatch(/Tuesday, January 8 at 2:00\s*PM/);
    expect(en.body).not.toMatch(/7:00\s*PM/);
  });

  it('does not notice a student absent from the only session that changed', async () => {
    const { m, enroll, api } = await scenario();
    const absent = await enroll();
    const present = await enroll();
    await createAbsence(ctx.prisma, { enrollmentId: absent.enrollment.id, sessionId: m.sessions[0][0].id });
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    expect(await noticesOf(absent.student.id)).toHaveLength(0);
    expect(await noticesOf(present.student.id)).toHaveLength(1);
  });

  it('still notices the absent student about the other changes of the module', async () => {
    const { m, enroll, api } = await scenario();
    const absent = await enroll();
    await createAbsence(ctx.prisma, { enrollmentId: absent.enrollment.id, sessionId: m.sessions[0][0].id });
    await api.cancel(m.sessions[0][1].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    expect(await noticesOf(absent.student.id)).toHaveLength(1);
  });

  it('lists only the dates the student attends when cancelling a series', async () => {
    const { m, enroll, api } = await scenario();
    const { student, enrollment } = await enroll();
    await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: m.sessions[0][1].id });
    await api.cancel(m.sessions[0][0].id, { scope: 'SERIES' }).expect(200);
    await ctx.runOutbox();
    const [notice] = await noticesOf(student.id);
    expect(notice.body).toContain('3 sesiones');
    expect(notice.body).not.toContain('15 de enero');
  });

  it('does not notice the teacher or the CAE (clarification of 2026-11-18)', async () => {
    const { m, enroll, api } = await scenario();
    await enroll();
    const admin = await ctx.prisma.user.create({
      data: { email: 'cae@correo.uts.edu.co', passwordHash: 'x', role: 'SUPERADMIN' },
    });
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    expect(await noticesOf(m.teacher.user.id)).toHaveLength(0);
    expect(await noticesOf(admin.id)).toHaveLength(0);
  });

  it('links each notice to its event and module, creates a push and an email delivery, and queues them', async () => {
    const { m, enroll, api } = await scenario();
    const { student } = await enroll();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();

    const event = await ctx.prisma.outboxEvent.findFirstOrThrow();
    expect(event.processedAt).not.toBeNull();
    const [notice] = await noticesOf(student.id);
    expect(notice.eventId).toBe(event.id);
    const deliveries = await ctx.prisma.notificationDelivery.findMany({ where: { notificationId: notice.id } });
    expect(deliveries.map((d) => d.channel).sort()).toEqual(['EMAIL', 'PUSH']);
    expect(deliveries.every((d) => d.status === 'PENDING' && d.attempts === 0)).toBe(true);
    expect(ctx.deliveryQueue.jobs.map((j) => j.id).sort()).toEqual(deliveries.map((d) => d.id).sort());
  });

  it('marks an event with no enrolled students as processed, without notices or deliveries', async () => {
    const { m, api } = await scenario();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    expect((await ctx.prisma.outboxEvent.findFirstOrThrow()).processedAt).not.toBeNull();
    expect(await ctx.prisma.notification.count()).toBe(0);
    expect(await ctx.prisma.notificationDelivery.count()).toBe(0);
    expect(ctx.deliveryQueue.jobs).toHaveLength(0);
  });

  it('marks an event of a deleted module as processed without notices', async () => {
    const { m, enroll, api } = await scenario();
    await enroll();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.prisma.module.update({ where: { id: m.module.id }, data: { deletedAt: new Date() } });
    await ctx.runOutbox();
    expect((await ctx.prisma.outboxEvent.findFirstOrThrow()).processedAt).not.toBeNull();
    expect(await ctx.prisma.notification.count()).toBe(0);
  });

  it('marks an event whose sessions no longer exist as processed without notices', async () => {
    const { m, enroll, api } = await scenario();
    await enroll();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.prisma.moduleSession.update({ where: { id: m.sessions[0][0].id }, data: { deletedAt: new Date() } });
    await ctx.runOutbox();
    expect((await ctx.prisma.outboxEvent.findFirstOrThrow()).processedAt).not.toBeNull();
    expect(await ctx.prisma.notification.count()).toBe(0);
  });

  it('keeps the events carrying no student data (FR-004)', async () => {
    const { m, enroll, api } = await scenario();
    const { student } = await enroll();
    await api.cancel(m.sessions[0][0].id, { scope: 'SESSION' }).expect(200);
    await ctx.runOutbox();
    const event = await ctx.prisma.outboxEvent.findFirstOrThrow();
    expect(JSON.stringify(event.payload)).not.toContain(student.id);
    expect(JSON.stringify(event.payload)).not.toContain(student.email);
  });
});
