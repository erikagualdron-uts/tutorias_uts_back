import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAbsence, createHoliday, createSession, createStudent, createEnrollment } from './utils/factories.js';
import { api as studentApi, loginStudent } from './utils/enrollment.js';
import { loginTeacher, teacherApi } from './utils/teacher.js';
import { enrollStudents, HOUR, MIN, seriesModule, start, THU, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const DAY = 24 * HOUR;
const NONE = '00000000-0000-4000-8000-000000000999';

describe('teacher sessions: reschedule', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const state = (id: string) => ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id } });
  const events = () => ctx.prisma.outboxEvent.findMany({ where: { type: 'SESSION_RESCHEDULED' } });
  // The same hour one day later: Wednesday 14:00 Bogota.
  const wednesday = (n = 0) => week(n, 19, 1);

  describe('window of 121, 120 and 119 minutes', () => {
    it.each([
      [121, 200],
      [120, 200],
      [119, 409],
    ])('a session %i minutes away answers %i', async (minutes, status) => {
      const period = await start(ctx);
      const m = await seriesModule(ctx, period.id);
      const first = m.sessions[0][0];
      ctx.clock.freezeAt(new Date(first.startsAt.getTime() - minutes * MIN));
      const res = await teacherApi(ctx, m.teacher).reschedule(first.id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      expect(res.status).toBe(status);
      if (status === 409) {
        expect(res.body).toMatchObject({ code: 'SESSION_CHANGE_WINDOW_PASSED', details: { minutes: 120 } });
        expect((await state(first.id)).startsAt.toISOString()).toBe(first.startsAt.toISOString());
        expect(await events()).toHaveLength(0);
      } else {
        expect((await state(first.id)).startsAt.toISOString()).toBe(wednesday().toISOString());
      }
    });
  });

  describe('scope', () => {
    it('SESSION moves only the chosen session, keeps its original hour, duration, room and teacher', async () => {
      const period = await start(ctx);
      const m = await seriesModule(ctx, period.id);
      const [s0, s1] = m.sessions[0];
      const res = await teacherApi(ctx, m.teacher).reschedule(s1.id, { scope: 'SESSION', startsAt: wednesday(1).toISOString() });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ scope: 'SESSION', dryRun: false });
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0]).toMatchObject({ id: s1.id, status: 'RESCHEDULED' });
      const moved = await state(s1.id);
      expect(moved).toMatchObject({ status: 'RESCHEDULED', roomId: m.room.id, teacherId: m.teacher.user.id });
      expect(moved.startsAt.toISOString()).toBe(wednesday(1).toISOString());
      expect(moved.endsAt.getTime() - moved.startsAt.getTime()).toBe(2 * HOUR);
      expect(moved.originalStartsAt.toISOString()).toBe(s1.startsAt.toISOString());
      expect((await state(s0.id)).status).toBe('SCHEDULED');
      expect((await state(m.sessions[0][2].id)).startsAt.toISOString()).toBe(m.sessions[0][2].startsAt.toISOString());
    });

    it('SERIES moves it and the future sessions of the same weekly slot by the same amount, and nothing else', async () => {
      const period = await start(ctx);
      const m = await seriesModule(ctx, period.id, { slots: [{ dayOfWeek: 2, startMinute: 840, endMinute: 960 }, THU] });
      const tuesdays = m.sessions[0];
      const thursdays = m.sessions[1];
      // a session of the series already cancelled by a holiday stays as it is
      await ctx.prisma.moduleSession.update({ where: { id: tuesdays[3].id }, data: { status: 'CANCELLED', cancelReason: 'HOLIDAY' } });
      const res = await teacherApi(ctx, m.teacher).reschedule(tuesdays[1].id, { scope: 'SERIES', startsAt: wednesday(1).toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual([tuesdays[1].id, tuesdays[2].id]);
      expect((await state(tuesdays[0].id)).status).toBe('SCHEDULED');
      expect((await state(tuesdays[1].id)).startsAt.toISOString()).toBe(wednesday(1).toISOString());
      expect((await state(tuesdays[2].id)).startsAt.toISOString()).toBe(wednesday(2).toISOString());
      expect(await state(tuesdays[3].id)).toMatchObject({ status: 'CANCELLED', cancelReason: 'HOLIDAY' });
      for (const t of thursdays) expect((await state(t.id)).status).toBe('SCHEDULED');
      const [event] = await events();
      expect(event.payload).toMatchObject({ scope: 'SERIES' });
      expect(await events()).toHaveLength(1);
    });

    it('goes back to SCHEDULED when moved to its original hour', async () => {
      const period = await start(ctx);
      const m = await seriesModule(ctx, period.id);
      const s = m.sessions[0][0];
      const api = teacherApi(ctx, m.teacher);
      await api.reschedule(s.id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      const back = await api.reschedule(s.id, { scope: 'SESSION', startsAt: s.startsAt.toISOString() });
      expect(back.status).toBe(200);
      expect(await state(s.id)).toMatchObject({ status: 'SCHEDULED' });
      expect((await state(s.id)).originalStartsAt.toISOString()).toBe(s.startsAt.toISOString());
    });
  });

  describe('the new date and hour', () => {
    const reason = async (period: { endsOn?: string } | undefined, newStart: (s: Date) => Date, expected: string, extra: object = {}) => {
      const p = await start(ctx, period);
      const m = await seriesModule(ctx, p.id);
      const s = m.sessions[0][0];
      const res = await teacherApi(ctx, m.teacher).reschedule(s.id, { scope: 'SESSION', startsAt: newStart(s.startsAt).toISOString() });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'SESSION_RESCHEDULE_INVALID_DATE', details: { reason: expected, ...extra } });
      expect((await state(s.id)).startsAt.toISOString()).toBe(s.startsAt.toISOString());
    };

    it('refuses no change', () => reason(undefined, (s) => s, 'NO_CHANGE'));
    it('refuses the past', async () => {
      const p = await start(ctx);
      const m = await seriesModule(ctx, p.id);
      const s = m.sessions[0][0];
      ctx.clock.freezeAt(new Date(s.startsAt.getTime() - 5 * HOUR));
      const res = await teacherApi(ctx, m.teacher).reschedule(s.id, {
        scope: 'SESSION',
        startsAt: new Date(s.startsAt.getTime() - 6 * HOUR).toISOString(),
      });
      expect(res.body).toMatchObject({ code: 'SESSION_RESCHEDULE_INVALID_DATE', details: { reason: 'PAST' } });
    });
    it('refuses another week', () => reason(undefined, (s) => new Date(s.getTime() + 7 * DAY), 'OUT_OF_WEEK'));
    it('refuses Monday 00:00 of the next week and accepts Sunday of the same week', async () => {
      const p = await start(ctx);
      const m = await seriesModule(ctx, p.id);
      const s = m.sessions[0][0];
      const api = teacherApi(ctx, m.teacher);
      const monday = await api.reschedule(s.id, { scope: 'SESSION', startsAt: '2030-01-14T11:00:00Z' });
      expect(monday.body.details.reason).toBe('OUT_OF_WEEK');
      expect((await api.reschedule(s.id, { scope: 'SESSION', startsAt: '2030-01-13T15:00:00Z' })).status).toBe(200);
    });
    it('refuses a date outside the period', () => reason({ endsOn: '2030-01-09' }, (s) => new Date(s.getTime() + 2 * DAY), 'OUT_OF_PERIOD'));
    it('refuses a holiday and names the date', async () => {
      await createHoliday(ctx.prisma, { date: '2030-01-10' });
      await reason(undefined, (s) => new Date(s.getTime() + 2 * DAY), 'HOLIDAY', { date: '2030-01-10' });
    });

    it('refuses hours outside 06:00 to 18:00 and allows ending at 18:00 sharp', async () => {
      const p = await start(ctx);
      const m = await seriesModule(ctx, p.id);
      const s = m.sessions[0][0];
      const api = teacherApi(ctx, m.teacher);
      // Tuesday 17:15 to 19:15 Bogota
      const late = await api.reschedule(s.id, { scope: 'SESSION', startsAt: '2030-01-08T22:15:00Z' });
      expect(late.status).toBe(422);
      expect(late.body).toMatchObject({ code: 'MODULE_SCHEDULE_OUT_OF_HOURS', details: { earliest: '06:00', latest: '18:00' } });
      // Tuesday 05:45 Bogota
      const early = await api.reschedule(s.id, { scope: 'SESSION', startsAt: '2030-01-08T10:45:00Z' });
      expect(early.body.code).toBe('MODULE_SCHEDULE_OUT_OF_HOURS');
      // Tuesday 16:00 to 18:00 Bogota
      expect((await api.reschedule(s.id, { scope: 'SESSION', startsAt: '2030-01-08T21:00:00Z' })).status).toBe(200);
    });
  });

  describe('room and teacher availability', () => {
    it('names the module that holds the room, and lets ending when another starts', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const b = await seriesModule(ctx, p.id, { roomId: a.room.id, name: 'Ocupa el salón', slots: [{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], weeks: 1 });
      const s = a.sessions[0][0];
      const api = teacherApi(ctx, a.teacher);
      const clash = await api.reschedule(s.id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      expect(clash.status).toBe(409);
      expect(clash.body).toMatchObject({
        code: 'MODULE_ROOM_CONFLICT',
        details: { conflict: { moduleName: 'Ocupa el salón', dayOfWeek: 3, startTime: '14:00', endTime: '16:00' } },
      });
      expect((await state(s.id)).status).toBe('SCHEDULED');
      // Wednesday 16:00 to 18:00 starts when the other ends
      expect((await api.reschedule(s.id, { scope: 'SESSION', startsAt: '2030-01-09T21:00:00Z' })).status).toBe(200);
      expect(b.module.id).toBeDefined();
    });

    it('names the module of the same teacher', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      await seriesModule(ctx, p.id, { teacherId: a.teacher.user.id, name: 'Otro del docente', slots: [{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], weeks: 1 });
      const res = await teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'MODULE_TEACHER_CONFLICT', details: { conflict: { moduleName: 'Otro del docente' } } });
    });

    it('ignores sessions that are cancelled', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const b = await seriesModule(ctx, p.id, { roomId: a.room.id, slots: [{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], weeks: 1 });
      await ctx.prisma.moduleSession.update({ where: { id: b.sessions[0][0].id }, data: { status: 'CANCELLED', cancelReason: 'HOLIDAY' } });
      expect((await teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() })).status).toBe(200);
    });
  });

  describe('enrolled students', () => {
    it('refuses when some already have another session then, with only the count', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const d = await seriesModule(ctx, p.id, { name: 'D', slots: [{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], weeks: 1 });
      const students = await enrollStudents(ctx, a.module.id, 3);
      for (const { student } of students.slice(0, 2)) {
        await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: d.module.id });
      }
      const res = await teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SESSION_STUDENT_CONFLICT', details: { students: 2 } });
      const text = JSON.stringify(res.body);
      for (const { student } of students) {
        expect(text).not.toContain(student.id);
        expect(text).not.toContain(student.email);
      }
    });

    it('does not count who skipped the session, inactive accounts or enrollments cancelled out of the window', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const d = await seriesModule(ctx, p.id, { name: 'D', slots: [{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], weeks: 1 });
      const students = await enrollStudents(ctx, a.module.id, 3);
      for (const { student } of students) await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: d.module.id });
      await createAbsence(ctx.prisma, { enrollmentId: students[0].enrollment.id, sessionId: a.sessions[0][0].id });
      await ctx.prisma.user.update({ where: { id: students[1].student.id }, data: { status: 'INACTIVE' } });
      const away = new Date('2030-01-01T00:00:00Z');
      await ctx.prisma.enrollment.updateMany({
        where: { studentId: students[2].student.id, moduleId: d.module.id },
        data: { status: 'CANCELLED', cancelledAt: away, effectiveUntil: away },
      });
      const res = await teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      expect(res.status).toBe(200);
    });

    it('lets the enrolled students see the new hour', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const student = await loginStudent(ctx);
      await createEnrollment(ctx.prisma, { studentId: student.user.id, moduleId: a.module.id });
      await teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      const detail = await studentApi(ctx, student).detail(a.module.id);
      const sessions = detail.body.sessions as { id: string; startsAt: string; status: string }[];
      const moved = sessions.find((s) => s.id === a.sessions[0][0].id)!;
      expect(moved).toMatchObject({ status: 'RESCHEDULED' });
      expect(moved.startsAt).toBe(wednesday().toISOString());
    });
  });

  describe('a series', () => {
    it('is all or nothing: a clash in the third session reverts everything and names it', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      await seriesModule(ctx, p.id, { roomId: a.room.id, slots: [{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], weeks: 1 });
      // the other module holds the room on Wednesday of week 2 instead of week 0
      await ctx.prisma.moduleSession.updateMany({ where: { roomId: a.room.id, moduleId: { not: a.module.id } }, data: { startsAt: wednesday(2), endsAt: new Date(wednesday(2).getTime() + 2 * HOUR), originalStartsAt: wednesday(2) } });
      const res = await teacherApi(ctx, a.teacher).reschedule(a.sessions[0][0].id, { scope: 'SERIES', startsAt: wednesday().toISOString() });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'MODULE_ROOM_CONFLICT', details: { sessionId: a.sessions[0][2].id } });
      for (const s of a.sessions[0]) expect((await state(s.id)).startsAt.toISOString()).toBe(s.startsAt.toISOString());
      expect(await events()).toHaveLength(0);
    });
  });

  describe('dryRun', () => {
    it('answers the new hours without writing or recording events', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const s = a.sessions[0][0];
      const res = await teacherApi(ctx, a.teacher).reschedule(s.id, { scope: 'SERIES', startsAt: wednesday().toISOString(), dryRun: true });
      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.sessions).toHaveLength(4);
      expect(res.body.sessions[0]).toMatchObject({ id: s.id, startsAt: wednesday().toISOString(), status: 'RESCHEDULED' });
      expect((await state(s.id)).status).toBe('SCHEDULED');
      expect(await events()).toHaveLength(0);
    });

    it('gives the same errors as the confirmation', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const api = teacherApi(ctx, a.teacher);
      const s = a.sessions[0][0];
      const res = await api.reschedule(s.id, { scope: 'SESSION', startsAt: new Date(s.startsAt.getTime() + 7 * DAY).toISOString(), dryRun: true });
      expect(res.status).toBe(422);
      expect(res.body.details.reason).toBe('OUT_OF_WEEK');
    });
  });

  describe('what can not be rescheduled', () => {
    it('refuses a past session, a cancelled one and a closed period', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const api = teacherApi(ctx, a.teacher);
      const [s0, s1] = a.sessions[0];
      ctx.clock.freezeAt(new Date(s0.startsAt.getTime() + 10 * MIN));
      const past = await api.reschedule(s0.id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
      expect(past.body).toMatchObject({ code: 'SESSION_NOT_CHANGEABLE', details: { reason: 'PAST' } });
      ctx.clock.freezeAt(new Date('2030-01-07T12:00:00Z'));
      await ctx.prisma.moduleSession.update({ where: { id: s1.id }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
      const cancelled = await api.reschedule(s1.id, { scope: 'SESSION', startsAt: wednesday(1).toISOString() });
      expect(cancelled.body).toMatchObject({ code: 'SESSION_NOT_CHANGEABLE', details: { reason: 'CANCELLED' } });
      await ctx.prisma.academicPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
      const closed = await api.reschedule(a.sessions[0][2].id, { scope: 'SESSION', startsAt: wednesday(2).toISOString() });
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
    });

    it('answers 404 for another teacher\'s session, an unknown one and a deleted one', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const stranger = await loginTeacher(ctx);
      const body = { scope: 'SESSION', startsAt: wednesday().toISOString() };
      expect((await teacherApi(ctx, stranger).reschedule(a.sessions[0][0].id, body)).status).toBe(404);
      expect((await teacherApi(ctx, a.teacher).reschedule(NONE, body)).status).toBe(404);
      await ctx.prisma.moduleSession.update({ where: { id: a.sessions[0][1].id }, data: { deletedAt: new Date() } });
      expect((await teacherApi(ctx, a.teacher).reschedule(a.sessions[0][1].id, body)).status).toBe(404);
    });

    it('answers 400 for a malformed start, an unknown scope and unknown fields', async () => {
      const p = await start(ctx);
      const a = await seriesModule(ctx, p.id);
      const api = teacherApi(ctx, a.teacher);
      const id = a.sessions[0][0].id;
      for (const body of [
        { scope: 'SESSION', startsAt: 'mañana' },
        { scope: 'ALL', startsAt: wednesday().toISOString() },
        { scope: 'SESSION', startsAt: wednesday().toISOString(), teacherId: NONE },
        { startsAt: wednesday().toISOString() },
      ]) {
        const res = await api.reschedule(id, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect((await ctx.http().post('/api/v1/teacher/sessions/nope/reschedule').set('Authorization', `Bearer ${a.teacher.token}`).send({ scope: 'SESSION', startsAt: wednesday().toISOString() })).status).toBe(400);
    });
  });

  it('keeps the helpers honest', async () => {
    expect(createSession).toBeDefined();
    expect(createStudent).toBeDefined();
  });
});
