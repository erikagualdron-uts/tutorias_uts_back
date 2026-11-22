import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activePeriod, moduleWithSessions } from './utils/enrollment.js';
import { createAdminSession, createStudent, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// Enrolling and deactivating the same student at once (spec 016, D-092 lock order).
describe('student deactivation under concurrency', () => {
  let ctx: TestContext;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    adminToken = (await createAdminSession(ctx)).token;
  });
  afterAll(() => ctx.close());

  const deactivate = (id: string) =>
    ctx.http().post(`/api/v1/students/${id}/deactivate`).set('Authorization', `Bearer ${adminToken}`);

  it('never leaves an ACTIVE enrollment of an INACTIVE student, with no deadlock (20 rounds)', async () => {
    const period = await activePeriod(ctx);
    const { module } = await moduleWithSessions(ctx, period.id, { capacity: 50 });
    for (let round = 0; round < 20; round++) {
      const student = await createStudent(ctx.prisma);
      const login = await ctx.http().post('/api/v1/auth/login').send({ email: student.email, password: TEST_PASSWORD });
      const enroll = ctx
        .http()
        .post('/api/v1/student/enrollments')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ moduleId: module.id });
      const [enrolled, closed] = await Promise.all([enroll, deactivate(student.id)]);

      expect(closed.status).toBe(200);
      expect([201, 401]).toContain(enrolled.status);
      expect(await ctx.prisma.enrollment.count({ where: { studentId: student.id, status: 'ACTIVE' } })).toBe(0);
    }
  });

  it('two simultaneous deactivations leave one coherent result', async () => {
    const period = await activePeriod(ctx);
    const { module } = await moduleWithSessions(ctx, period.id);
    const student = await createStudent(ctx.prisma);
    await ctx.prisma.enrollment.create({ data: { studentId: student.id, moduleId: module.id } });

    const [a, b] = await Promise.all([deactivate(student.id), deactivate(student.id)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.cancelledEnrollments, b.body.cancelledEnrollments].sort((x, y) => x - y)).toEqual([0, 1]);
    expect(await ctx.prisma.enrollment.count({ where: { studentId: student.id, status: 'CANCELLED' } })).toBe(1);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: student.id } })).status).toBe('INACTIVE');
  });
});
