import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attendingStudents } from '../src/notifications/recipients.js';
import { createAbsence, createEnrollment, createStudent } from './utils/factories.js';
import { HOUR, seriesModule, start, week } from './utils/teacher-fixture.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// Who must hear about a change (FR-003): a student attends a session when the enrollment is ACTIVE,
// or CANCELLED with the session before effective_until, and has no live absence for it.
describe('notification recipients', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  async function setup() {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id);
    return { m, ids: m.sessions[0].map((s) => s.id) };
  }
  const forSessions = (ids: string[]) => attendingStudents(ctx.prisma, { sessionIds: ids });

  it('includes a student with an ACTIVE enrollment, for every session named', async () => {
    const { m, ids } = await setup();
    const student = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
    const result = await forSessions(ids);
    expect([...result.keys()]).toEqual([student.id]);
    expect(result.get(student.id)?.sort()).toEqual([...ids].sort());
  });

  it('keeps a CANCELLED student only for the sessions before effective_until', async () => {
    const { m, ids } = await setup();
    const student = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, {
      studentId: student.id,
      moduleId: m.module.id,
      status: 'CANCELLED',
      effectiveUntil: new Date(week(1).getTime() + HOUR),
    });
    const result = await forSessions(ids);
    expect(result.get(student.id)?.sort()).toEqual([ids[0], ids[1]].sort());
  });

  it('excludes a CANCELLED student whose cancellation is already in force', async () => {
    const { m, ids } = await setup();
    const student = await createStudent(ctx.prisma);
    await createEnrollment(ctx.prisma, {
      studentId: student.id,
      moduleId: m.module.id,
      status: 'CANCELLED',
      effectiveUntil: new Date(week(0).getTime() - HOUR),
    });
    expect((await forSessions(ids)).size).toBe(0);
  });

  it('excludes a student who is not enrolled in the module', async () => {
    const { ids } = await setup();
    await createStudent(ctx.prisma);
    expect((await forSessions(ids)).size).toBe(0);
  });

  it('excludes inactive and deleted accounts', async () => {
    const { m, ids } = await setup();
    const inactive = await createStudent(ctx.prisma, { status: 'INACTIVE' });
    const deleted = await createStudent(ctx.prisma, { deletedAt: new Date() });
    for (const student of [inactive, deleted]) {
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
    }
    expect((await forSessions(ids)).size).toBe(0);
  });

  it('excludes a student whose enrollment was soft-deleted', async () => {
    const { m, ids } = await setup();
    const student = await createStudent(ctx.prisma);
    const enrollment = await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
    await ctx.prisma.enrollment.update({ where: { id: enrollment.id }, data: { deletedAt: new Date() } });
    expect((await forSessions(ids)).size).toBe(0);
  });

  describe('absences', () => {
    it('excludes a student absent from the only session named', async () => {
      const { m, ids } = await setup();
      const student = await createStudent(ctx.prisma);
      const enrollment = await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: ids[0] });
      expect((await forSessions([ids[0]])).size).toBe(0);
    });

    it('lists only the sessions the student attends when absent from some', async () => {
      const { m, ids } = await setup();
      const student = await createStudent(ctx.prisma);
      const enrollment = await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: ids[1] });
      const result = await forSessions(ids);
      expect(result.get(student.id)?.sort()).toEqual([ids[0], ids[2], ids[3]].sort());
    });

    it('excludes a student absent from every session named', async () => {
      const { m, ids } = await setup();
      const student = await createStudent(ctx.prisma);
      const enrollment = await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      for (const id of ids) await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: id });
      expect((await forSessions(ids)).size).toBe(0);
    });

    it('counts an absence that was restored (deletedAt) as attending', async () => {
      const { m, ids } = await setup();
      const student = await createStudent(ctx.prisma);
      const enrollment = await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      await createAbsence(ctx.prisma, { enrollmentId: enrollment.id, sessionId: ids[0], deletedAt: new Date() });
      expect((await forSessions([ids[0]])).get(student.id)).toEqual([ids[0]]);
    });
  });

  describe('module-wide changes (teacher or room)', () => {
    it('uses the live sessions after the given instant', async () => {
      const { m, ids } = await setup();
      const student = await createStudent(ctx.prisma);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      const after = new Date(week(1).getTime() + HOUR);
      const result = await attendingStudents(ctx.prisma, { moduleId: m.module.id, after });
      expect(result.get(student.id)?.sort()).toEqual([ids[2], ids[3]].sort());
    });

    it('ignores cancelled and deleted sessions', async () => {
      const { m, ids } = await setup();
      const student = await createStudent(ctx.prisma);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      await ctx.prisma.moduleSession.update({ where: { id: ids[2] }, data: { status: 'CANCELLED', cancelReason: 'TEACHER' } });
      await ctx.prisma.moduleSession.update({ where: { id: ids[3] }, data: { deletedAt: new Date() } });
      const result = await attendingStudents(ctx.prisma, { moduleId: m.module.id, after: new Date(0) });
      expect(result.get(student.id)?.sort()).toEqual([ids[0], ids[1]].sort());
    });

    it('returns nobody when no session is left after the instant', async () => {
      const { m } = await setup();
      const student = await createStudent(ctx.prisma);
      await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
      const result = await attendingStudents(ctx.prisma, { moduleId: m.module.id, after: new Date('2031-01-01') });
      expect(result.size).toBe(0);
    });
  });
});
