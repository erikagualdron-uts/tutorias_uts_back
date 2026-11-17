import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPeriod, createSession } from './utils/factories.js';
import { activePeriod, api, loginStudent, moduleWithSessions } from './utils/enrollment.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('student enrollment: cancel and restore a session', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  // A module with a single session `minutes` after the frozen "now", and a student enrolled in it.
  async function setup(minutes: number, capacity = 5) {
    const now = new Date();
    ctx.clock.freezeAt(now);
    const period = await activePeriod(ctx);
    const fixture = await moduleWithSessions(ctx, period.id, { capacity, hoursAhead: [] });
    const session = await createSession(ctx.prisma, {
      moduleId: fixture.module.id,
      scheduleId: fixture.module.schedules[0].id,
      teacherId: fixture.teacher.id,
      roomId: fixture.room.id,
      startsAt: new Date(now.getTime() + minutes * MIN),
    });
    const s = await loginStudent(ctx);
    const student = api(ctx, s);
    const enrollment = await student.enroll(fixture.module.id);
    return { ...fixture, session, student, studentRow: s, enrollmentId: enrollment.body.id as string, now, period };
  }

  describe('windows of 61, 60 and 59 minutes', () => {
    it.each([
      [61, 200],
      [60, 200],
      [59, 409],
    ])('a session %i minutes away answers %i', async (minutes, status) => {
      const t = await setup(minutes);
      const res = await t.student.cancelSession(t.enrollmentId, t.session.id);
      expect(res.status).toBe(status);
      if (status === 409) {
        expect(res.body).toMatchObject({ code: 'ENROLLMENT_CANCEL_WINDOW_PASSED', details: { minutes: 60 } });
        expect(await ctx.prisma.sessionAbsence.count()).toBe(0);
      } else {
        expect(res.body).toMatchObject({ id: t.session.id, cancelledByStudent: true, canCancel: false });
      }
    });

    it('keeps the enrollment ACTIVE and the other sessions untouched', async () => {
      const t = await setup(61 + 24 * 60);
      const other = await createSession(ctx.prisma, {
        moduleId: t.module.id,
        scheduleId: t.module.schedules[0].id,
        teacherId: t.teacher.id,
        roomId: t.room.id,
        startsAt: new Date(t.now.getTime() + 200 * HOUR),
      });
      await t.student.cancelSession(t.enrollmentId, t.session.id);
      expect((await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: t.enrollmentId } })).status).toBe('ACTIVE');
      const sessions = (await t.student.detail(t.module.id)).body.sessions as { id: string; cancelledByStudent: boolean }[];
      expect(sessions.find((s) => s.id === other.id)?.cancelledByStudent).toBe(false);
    });

    it('lets the restore window follow the same rule', async () => {
      const t = await setup(61);
      await t.student.cancelSession(t.enrollmentId, t.session.id);
      ctx.clock.freezeAt(new Date(t.now.getTime() + 2 * MIN)); // now the session is 59 minutes away
      const res = await t.student.restoreSession(t.enrollmentId, t.session.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ENROLLMENT_CANCEL_WINDOW_PASSED');
    });
  });

  it('frees the seat of that session only; the module stays full if another session is', async () => {
    const t = await setup(48 * 60, 1);
    const second = await createSession(ctx.prisma, {
      moduleId: t.module.id,
      scheduleId: t.module.schedules[0].id,
      teacherId: t.teacher.id,
      roomId: t.room.id,
      startsAt: new Date(t.now.getTime() + 300 * HOUR),
    });
    await t.student.cancelSession(t.enrollmentId, t.session.id);
    const other = api(ctx, await loginStudent(ctx));
    const sessions = (await other.detail(t.module.id)).body.sessions as { id: string; freeSeats: number }[];
    expect(sessions.find((s) => s.id === t.session.id)?.freeSeats).toBe(1);
    expect(sessions.find((s) => s.id === second.id)?.freeSeats).toBe(0);
    expect((await other.detail(t.module.id)).body.state).toBe('FULL');
  });

  it('is idempotent: cancelling twice leaves one live absence, restoring twice one deleted', async () => {
    const t = await setup(48 * 60);
    expect((await t.student.cancelSession(t.enrollmentId, t.session.id)).status).toBe(200);
    expect((await t.student.cancelSession(t.enrollmentId, t.session.id)).status).toBe(200);
    expect(await ctx.prisma.sessionAbsence.count({ where: { deletedAt: null } })).toBe(1);
    expect((await t.student.restoreSession(t.enrollmentId, t.session.id)).status).toBe(200);
    expect((await t.student.restoreSession(t.enrollmentId, t.session.id)).status).toBe(200);
    expect(await ctx.prisma.sessionAbsence.count({ where: { deletedAt: null } })).toBe(0);
    expect(await ctx.prisma.sessionAbsence.count()).toBe(1); // soft deleted, never removed
  });

  it('restores a session when there is room, refuses when another student took the seat', async () => {
    const t = await setup(48 * 60, 1);
    await t.student.cancelSession(t.enrollmentId, t.session.id);
    const taker = api(ctx, await loginStudent(ctx));
    expect((await taker.enroll(t.module.id)).status).toBe(201);
    const res = await t.student.restoreSession(t.enrollmentId, t.session.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENROLLMENT_MODULE_FULL');
    const detail = (await t.student.detail(t.module.id)).body.sessions[0];
    expect(detail).toMatchObject({ cancelledByStudent: true, canRestore: false, blockReason: 'NO_SEAT' });
  });

  it('refuses a session that is cancelled by holiday or already past', async () => {
    const t = await setup(48 * 60);
    const holiday = await createSession(ctx.prisma, {
      moduleId: t.module.id,
      scheduleId: t.module.schedules[0].id,
      teacherId: t.teacher.id,
      roomId: t.room.id,
      startsAt: new Date(t.now.getTime() + 72 * HOUR),
      status: 'CANCELLED',
    });
    const past = await createSession(ctx.prisma, {
      moduleId: t.module.id,
      scheduleId: t.module.schedules[0].id,
      teacherId: t.teacher.id,
      roomId: t.room.id,
      startsAt: new Date(t.now.getTime() - 24 * HOUR),
    });
    for (const id of [holiday.id, past.id]) {
      const res = await t.student.cancelSession(t.enrollmentId, id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ENROLLMENT_SESSION_NOT_CANCELLABLE');
    }
  });

  it('refuses a cancelled enrollment and a closed period', async () => {
    const t = await setup(48 * 60);
    await ctx.prisma.academicPeriod.update({ where: { id: t.period.id }, data: { status: 'CLOSED' } });
    const closed = await t.student.cancelSession(t.enrollmentId, t.session.id);
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
    await ctx.prisma.academicPeriod.update({ where: { id: t.period.id }, data: { status: 'ACTIVE' } });
    await ctx.prisma.enrollment.update({
      where: { id: t.enrollmentId },
      data: { status: 'CANCELLED', cancelledAt: t.now, effectiveUntil: t.now },
    });
    const res = await t.student.cancelSession(t.enrollmentId, t.session.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENROLLMENT_NOT_ACTIVE');
  });

  it('answers 404 for another student\'s enrollment, another module\'s session or a missing one', async () => {
    const t = await setup(48 * 60);
    const stranger = api(ctx, await loginStudent(ctx));
    expect((await stranger.cancelSession(t.enrollmentId, t.session.id)).status).toBe(404);
    const elsewhere = await moduleWithSessions(ctx, t.period.id, { slot: { dayOfWeek: 5, startMinute: 600, endMinute: 720 } });
    expect((await t.student.cancelSession(t.enrollmentId, elsewhere.sessions[0].id)).status).toBe(404);
    expect((await t.student.cancelSession(t.enrollmentId, '00000000-0000-4000-8000-000000000999')).status).toBe(404);
    expect((await t.student.cancelSession('00000000-0000-4000-8000-000000000999', t.session.id)).status).toBe(404);
  });

  it('shows canCancel, canRestore and the blocking reason in the detail', async () => {
    const t = await setup(48 * 60);
    const near = await createSession(ctx.prisma, {
      moduleId: t.module.id,
      scheduleId: t.module.schedules[0].id,
      teacherId: t.teacher.id,
      roomId: t.room.id,
      startsAt: new Date(t.now.getTime() + 30 * MIN),
    });
    const holiday = await createSession(ctx.prisma, {
      moduleId: t.module.id,
      scheduleId: t.module.schedules[0].id,
      teacherId: t.teacher.id,
      roomId: t.room.id,
      startsAt: new Date(t.now.getTime() + 96 * HOUR),
      status: 'CANCELLED',
    });
    const sessions = (await t.student.detail(t.module.id)).body.sessions as { id: string }[];
    const by = (id: string) => sessions.find((s) => s.id === id);
    expect(by(t.session.id)).toMatchObject({ canCancel: true, canRestore: false, blockReason: null, cancelledByStudent: false });
    expect(by(near.id)).toMatchObject({ canCancel: false, blockReason: 'WINDOW_PASSED' });
    expect(by(holiday.id)).toMatchObject({ canCancel: false, blockReason: 'SESSION_CANCELLED' });
    expect((await t.student.detail(t.module.id)).body.cancelLeadMinutes).toBe(60);
  });
});

describe('student enrollment: cancel the module and enroll again', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  async function setup(hoursAhead: number[], capacity = 2) {
    const now = new Date();
    ctx.clock.freezeAt(now);
    const period = await activePeriod(ctx);
    const fixture = await moduleWithSessions(ctx, period.id, { capacity, hoursAhead });
    // the sessions were created against the real clock; the frozen "now" is a few ms later
    const student = api(ctx, await loginStudent(ctx));
    const enrollment = await student.enroll(fixture.module.id);
    return { ...fixture, student, enrollmentId: enrollment.body.id as string, now, period };
  }

  it('cancels, sets cancelledAt and effectiveUntil (+60 min) and frees every seat', async () => {
    const t = await setup([48, 100]);
    const res = await t.student.cancelModule(t.enrollmentId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(new Date(res.body.cancelledAt).getTime()).toBe(t.now.getTime());
    expect(new Date(res.body.effectiveUntil).getTime()).toBe(t.now.getTime() + HOUR);
    const other = api(ctx, await loginStudent(ctx));
    expect((await other.detail(t.module.id)).body.availableSeats).toBe(2);
  });

  it('keeps the student in a session that starts within the lead window', async () => {
    const t = await setup([48]);
    const soon = await createSession(ctx.prisma, {
      moduleId: t.module.id,
      scheduleId: t.module.schedules[0].id,
      teacherId: t.teacher.id,
      roomId: t.room.id,
      startsAt: new Date(t.now.getTime() + 30 * MIN),
    });
    await t.student.cancelModule(t.enrollmentId);
    const sessions = (await api(ctx, await loginStudent(ctx)).detail(t.module.id)).body.sessions as { id: string; freeSeats: number }[];
    expect(sessions.find((s) => s.id === soon.id)?.freeSeats).toBe(1);
    expect(sessions.find((s) => s.id === t.sessions[0].id)?.freeSeats).toBe(2);
  });

  it('refuses a second cancellation', async () => {
    const t = await setup([48]);
    expect((await t.student.cancelModule(t.enrollmentId)).status).toBe(200);
    const again = await t.student.cancelModule(t.enrollmentId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ENROLLMENT_NOT_ACTIVE');
  });

  it('refuses a closed period', async () => {
    const t = await setup([48]);
    await ctx.prisma.academicPeriod.update({ where: { id: t.period.id }, data: { status: 'CLOSED' } });
    const closed = await t.student.cancelModule(t.enrollmentId);
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
  });

  it('enrolls again as a new ACTIVE row, keeps the old one and never counts the student twice', async () => {
    const t = await setup([48, 100], 1);
    await t.student.cancelModule(t.enrollmentId);
    const again = await t.student.enroll(t.module.id);
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(t.enrollmentId);
    const rows = await ctx.prisma.enrollment.findMany({ where: { moduleId: t.module.id } });
    expect(rows.map((r) => r.status).sort()).toEqual(['ACTIVE', 'CANCELLED']);
    // capacity 1: the same student is one attendee even with a cancelled row inside the window
    expect((await t.student.detail(t.module.id)).body.availableSeats).toBe(0);
  });

  it('refuses to enroll again when the module became full', async () => {
    const t = await setup([48], 1);
    await t.student.cancelModule(t.enrollmentId);
    expect((await api(ctx, await loginStudent(ctx)).enroll(t.module.id)).status).toBe(201);
    const res = await t.student.enroll(t.module.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENROLLMENT_MODULE_FULL');
  });

  it('never deletes rows and answers 404 for another student\'s enrollment', async () => {
    const t = await setup([48]);
    const stranger = api(ctx, await loginStudent(ctx));
    expect((await stranger.cancelModule(t.enrollmentId)).status).toBe(404);
    await t.student.cancelModule(t.enrollmentId);
    expect(await ctx.prisma.enrollment.count()).toBe(1);
    expect(await createPeriod(ctx.prisma)).toBeDefined();
  });
});
