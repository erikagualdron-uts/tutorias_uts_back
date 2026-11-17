import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnrollment, createRoom, createUser, TEST_PASSWORD } from './utils/factories.js';
import { activePeriod, api, loginStudent, moduleWithSessions } from './utils/enrollment.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// SC-002: no over-enrollment even when requests arrive together. The module and student rows are
// locked in a fixed order (period, student, module) and partial unique indexes back the rules.
describe('student enrollment: concurrency', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  it('keeps exactly 5 enrollments when 20 students enroll at once in a module of capacity 5', async () => {
    const period = await activePeriod(ctx);
    const { module } = await moduleWithSessions(ctx, period.id, { capacity: 5 });
    const students = await Promise.all(Array.from({ length: 20 }, () => loginStudent(ctx)));
    const results = await Promise.all(students.map((s) => api(ctx, s).enroll(module.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(15);
    expect(refused.every((r) => r.body.code === 'ENROLLMENT_MODULE_FULL')).toBe(true);
    expect(await ctx.prisma.enrollment.count({ where: { moduleId: module.id, status: 'ACTIVE' } })).toBe(5);
  });

  it('keeps one enrollment when the same student sends 5 requests at once', async () => {
    const period = await activePeriod(ctx);
    const { module } = await moduleWithSessions(ctx, period.id);
    const student = api(ctx, await loginStudent(ctx));
    const results = await Promise.all(Array.from({ length: 5 }, () => student.enroll(module.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'ENROLLMENT_ALREADY_ACTIVE')).toBe(true);
    expect(await ctx.prisma.enrollment.count()).toBe(1);
  });

  it('lets only one of two overlapping modules through when the student enrolls in both at once', async () => {
    const period = await activePeriod(ctx);
    const slot = { dayOfWeek: 2, startMinute: 840, endMinute: 960 };
    const a = await moduleWithSessions(ctx, period.id, { name: 'A', slot });
    const b = await moduleWithSessions(ctx, period.id, { name: 'B', slot });
    const student = api(ctx, await loginStudent(ctx));
    const results = await Promise.all([student.enroll(a.module.id), student.enroll(b.module.id)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('ENROLLMENT_SCHEDULE_CONFLICT');
    expect(await ctx.prisma.enrollment.count()).toBe(1);
  });

  async function adminToken() {
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const res = await ctx.http().post('/api/v1/auth/login').send({ email: admin.email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  }

  it('never leaves more enrolled than the new room when an enrollment and a room change race', async () => {
    const token = await adminToken();
    for (let round = 0; round < 4; round++) {
      await ctx.reset();
      const admin = await adminToken();
      const period = await activePeriod(ctx);
      const { module } = await moduleWithSessions(ctx, period.id, { capacity: 30 });
      const small = await createRoom(ctx.prisma, { capacity: 1 });
      const first = await loginStudent(ctx);
      await createEnrollment(ctx.prisma, { studentId: first.user.id, moduleId: module.id });
      const second = await loginStudent(ctx);
      const [enrolled, changed] = await Promise.all([
        api(ctx, second).enroll(module.id),
        ctx.http().patch(`/api/v1/modules/${module.id}/room`).set('Authorization', `Bearer ${admin}`).send({ roomId: small.id }),
      ]);
      const total = await ctx.prisma.enrollment.count({ where: { moduleId: module.id, status: 'ACTIVE' } });
      const row = await ctx.prisma.module.findUniqueOrThrow({ where: { id: module.id }, include: { room: true } });
      expect(total, `round ${round}`).toBeLessThanOrEqual(row.room.capacity);
      // exactly one side wins: either the student got the seat (room change refused) or the room shrank first
      expect([enrolled.status, changed.status]).toSatisfy((codes: number[]) => codes.includes(409));
    }
    expect(token).toBeDefined();
  });

  it('keeps a room capacity edit and enrollments consistent: enrolled never exceeds the capacity', async () => {
    const admin = await adminToken();
    const period = await activePeriod(ctx);
    const { module, room } = await moduleWithSessions(ctx, period.id, { capacity: 6 });
    const students = await Promise.all(Array.from({ length: 6 }, () => loginStudent(ctx)));
    await Promise.all([
      ctx.http().patch(`/api/v1/rooms/${room.id}`).set('Authorization', `Bearer ${admin}`).send({ capacity: 2 }),
      ...students.map((s) => api(ctx, s).enroll(module.id)),
    ]);
    const current = await ctx.prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    const enrolled = await ctx.prisma.enrollment.count({ where: { moduleId: module.id, status: 'ACTIVE' } });
    expect(enrolled).toBeLessThanOrEqual(current.capacity);
  });
});
