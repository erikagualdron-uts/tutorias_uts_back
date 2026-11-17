import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnrollment, createRoom, createStudent, createUser, TEST_PASSWORD } from './utils/factories.js';
import { activePeriod, moduleWithSessions } from './utils/enrollment.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// The rules the CAE already had (spec 010 and 006) now run on real enrollments: no FakeConfigUsage
// value is fixed here.
describe('CAE rules with real enrollments (US4)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const res = await ctx.http().post('/api/v1/auth/login').send({ email: admin.email, password: TEST_PASSWORD });
    token = res.body.accessToken as string;
  });
  afterAll(() => ctx.close());

  const call = (method: 'get' | 'patch' | 'put' | 'delete', url: string, body?: object) => {
    const req = ctx.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  async function moduleWith(enrolled: number, capacity = 30) {
    const period = await activePeriod(ctx);
    const fixture = await moduleWithSessions(ctx, period.id, { capacity });
    const enrollments = [];
    for (let i = 0; i < enrolled; i++) {
      const student = await createStudent(ctx.prisma);
      enrollments.push(await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: fixture.module.id }));
    }
    return { ...fixture, period, enrollments };
  }

  it('shows the real number of enrolled students in the list and the detail', async () => {
    const { module } = await moduleWith(3);
    expect((await call('get', '/modules')).body.data[0].enrolled).toBe(3);
    expect((await call('get', `/modules/${module.id}`)).body).toMatchObject({ enrolled: 3, canChangeSchedules: false, canDelete: false });
  });

  it('blocks a room change below the enrolled students and allows an equal or larger one', async () => {
    const { module } = await moduleWith(5);
    const small = await createRoom(ctx.prisma, { capacity: 4 });
    const equal = await createRoom(ctx.prisma, { capacity: 5 });
    const blocked = await call('patch', `/modules/${module.id}/room`, { roomId: small.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'MODULE_ROOM_CAPACITY_BELOW_ENROLLED', details: { enrolled: 5, capacity: 4 } });
    expect((await call('patch', `/modules/${module.id}/room`, { roomId: equal.id })).status).toBe(200);
  });

  it('blocks editing schedules and deleting while there are enrolled students', async () => {
    const { module } = await moduleWith(2);
    const schedules = { schedules: [{ dayOfWeek: 4, startTime: '10:00', endTime: '12:00' }] };
    for (const res of [await call('put', `/modules/${module.id}/schedules`, schedules), await call('delete', `/modules/${module.id}`)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'MODULE_HAS_ENROLLMENTS', details: { enrolled: 2 } });
    }
  });

  it('allows both once every enrolled student has cancelled', async () => {
    const { module, enrollments } = await moduleWith(2);
    const now = new Date();
    await ctx.prisma.enrollment.updateMany({
      where: { id: { in: enrollments.map((e) => e.id) } },
      data: { status: 'CANCELLED', cancelledAt: now, effectiveUntil: now },
    });
    const schedules = { schedules: [{ dayOfWeek: 4, startTime: '10:00', endTime: '12:00' }] };
    expect((await call('put', `/modules/${module.id}/schedules`, schedules)).status).toBe(200);
    expect((await call('delete', `/modules/${module.id}`)).status).toBe(204);
  });

  it('keeps an enrollment of a deactivated or deleted student but does not count it (FR-015)', async () => {
    const { module, enrollments } = await moduleWith(2);
    await ctx.prisma.user.update({ where: { id: enrollments[0].studentId }, data: { status: 'INACTIVE' } });
    expect((await call('get', `/modules/${module.id}`)).body.enrolled).toBe(1);
    await ctx.prisma.user.update({ where: { id: enrollments[1].studentId }, data: { deletedAt: new Date() } });
    expect((await call('get', `/modules/${module.id}`)).body.enrolled).toBe(0);
    expect(await ctx.prisma.enrollment.count({ where: { moduleId: module.id, status: 'ACTIVE' } })).toBe(2);
    await ctx.prisma.user.update({ where: { id: enrollments[0].studentId }, data: { status: 'ACTIVE' } });
    expect((await call('get', `/modules/${module.id}`)).body.enrolled).toBe(1);
  });

  it('counts an enrolled student once even if they skipped sessions', async () => {
    const { module, enrollments, sessions } = await moduleWith(1);
    await ctx.prisma.sessionAbsence.create({ data: { enrollmentId: enrollments[0].id, sessionId: sessions[0].id } });
    expect((await call('get', `/modules/${module.id}`)).body.enrolled).toBe(1);
  });

  it('applies the room capacity rule of spec 006 with the largest real enrollment', async () => {
    const { room } = await moduleWith(5, 30);
    const below = await call('patch', `/rooms/${room.id}`, { capacity: 4 });
    expect(below.status).toBe(409);
    expect(below.body).toMatchObject({ code: 'ROOM_CAPACITY_BELOW_ENROLLED', details: { maxEnrolled: 5 } });
    expect((await call('patch', `/rooms/${room.id}`, { capacity: 5 })).status).toBe(200);
  });
});
