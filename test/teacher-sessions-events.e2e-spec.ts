import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHoliday } from './utils/factories.js';
import { teacherApi } from './utils/teacher.js';
import { enrollStudents, MIN, seriesModule, start, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// Every accepted change leaves one event for the notifications of spec 013, saved with the change;
// a rejected one leaves nothing. The events carry ids, dates and the scope, never data of students.
describe('teacher sessions: events', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const wednesday = (n = 0) => week(n, 19, 1);
  const all = () => ctx.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });

  it('leaves one event per accepted action with the data of the change', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id);
    const api = teacherApi(ctx, m.teacher);
    const [s0, s1] = m.sessions[0];

    await api.reschedule(s0.id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
    await api.cancel(s1.id, { scope: 'SESSION' });
    await api.restore(s1.id, { scope: 'SESSION' });

    const events = await all();
    expect(events.map((e) => e.type)).toEqual(['SESSION_RESCHEDULED', 'SESSION_CANCELLED_TEACHER', 'SESSION_RESTORED_TEACHER']);
    expect(events.every((e) => e.moduleId === m.module.id && e.processedAt === null)).toBe(true);
    expect(events[0].payload).toEqual({
      scope: 'SESSION',
      sessions: [{ sessionId: s0.id, from: s0.startsAt.toISOString(), to: wednesday().toISOString() }],
    });
    expect(events[1].payload).toEqual({ scope: 'SESSION', sessions: [{ sessionId: s1.id, from: s1.startsAt.toISOString() }] });
    expect(events[2].payload).toEqual({ scope: 'SESSION', sessions: [{ sessionId: s1.id, to: s1.startsAt.toISOString() }] });
  });

  it('records one event for a whole series, with every session in it', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id);
    const api = teacherApi(ctx, m.teacher);
    await api.reschedule(m.sessions[0][0].id, { scope: 'SERIES', startsAt: wednesday().toISOString() });
    const events = await all();
    expect(events).toHaveLength(1);
    expect((events[0].payload as { sessions: unknown[] }).sessions).toHaveLength(4);
    expect(events[0].payload).toMatchObject({ scope: 'SERIES' });
  });

  it('carries no data of the enrolled students', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id);
    const students = await enrollStudents(ctx, m.module.id, 3);
    const api = teacherApi(ctx, m.teacher);
    await api.reschedule(m.sessions[0][0].id, { scope: 'SESSION', startsAt: wednesday().toISOString() });
    await api.cancel(m.sessions[0][1].id, { scope: 'SESSION' });
    const text = JSON.stringify(await all());
    for (const { student } of students) {
      expect(text).not.toContain(student.id);
      expect(text).not.toContain(student.email);
    }
  });

  it('leaves nothing when the action is refused: window, clash, holiday, closed period or a failing series', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id);
    const other = await seriesModule(ctx, p.id, { roomId: m.room.id, slots: [{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], weeks: 1 });
    await ctx.prisma.moduleSession.updateMany({
      where: { moduleId: other.module.id },
      data: { startsAt: wednesday(2), endsAt: new Date(wednesday(2).getTime() + 2 * 60 * MIN), originalStartsAt: wednesday(2) },
    });
    await createHoliday(ctx.prisma, { date: '2030-01-10' });
    const api = teacherApi(ctx, m.teacher);
    const [s0, s1] = m.sessions[0];

    // a series whose third session clashes
    expect((await api.reschedule(s0.id, { scope: 'SERIES', startsAt: wednesday().toISOString() })).status).toBe(409);
    // a holiday
    expect((await api.reschedule(s0.id, { scope: 'SESSION', startsAt: week(0, 19, 2).toISOString() })).status).toBe(422);
    // the window
    ctx.clock.freezeAt(new Date(s0.startsAt.getTime() - 119 * MIN));
    expect((await api.cancel(s0.id, { scope: 'SESSION' })).status).toBe(409);
    expect((await api.reschedule(s0.id, { scope: 'SESSION', startsAt: wednesday().toISOString() })).status).toBe(409);
    // a session that was never cancelled can not be restored
    ctx.clock.freezeAt(new Date('2030-01-07T12:00:00Z'));
    expect((await api.restore(s1.id, { scope: 'SESSION' })).status).toBe(409);
    // a closed period
    await ctx.prisma.academicPeriod.update({ where: { id: p.id }, data: { status: 'CLOSED' } });
    expect((await api.cancel(s1.id, { scope: 'SESSION' })).status).toBe(409);

    expect(await all()).toHaveLength(0);
    for (const s of m.sessions[0]) {
      const row = await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.startsAt.toISOString()).toBe(s.startsAt.toISOString());
      expect(row.status).toBe('SCHEDULED');
    }
  });

  it('records nothing on a dry run, and a retry after a refusal does not duplicate the event', async () => {
    const p = await start(ctx);
    const m = await seriesModule(ctx, p.id);
    const api = teacherApi(ctx, m.teacher);
    const s0 = m.sessions[0][0];
    expect((await api.reschedule(s0.id, { scope: 'SESSION', startsAt: wednesday().toISOString(), dryRun: true })).status).toBe(200);
    expect(await all()).toHaveLength(0);
    ctx.clock.freezeAt(new Date(s0.startsAt.getTime() - 119 * MIN));
    expect((await api.cancel(s0.id, { scope: 'SESSION' })).status).toBe(409);
    ctx.clock.freezeAt(new Date('2030-01-07T12:00:00Z'));
    expect((await api.cancel(s0.id, { scope: 'SESSION' })).status).toBe(200);
    expect(await all()).toHaveLength(1);
  });
});
