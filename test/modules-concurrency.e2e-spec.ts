import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPeriod, createRoom, createTeacher, createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const tuesday = { dayOfWeek: 2, startTime: '14:00', endTime: '16:00' };
const PERIOD = { startsOn: '2030-01-07', endsOn: '2030-03-03' };

// SC-002: no overlap is possible even when the requests arrive at the same time, because the
// database refuses the second write (exclusion constraints) and the service turns it into a code.
describe('modules: concurrency (US1)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const res = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: admin.email, password: TEST_PASSWORD });
    token = res.body.accessToken as string;
  });
  afterAll(() => ctx.close());

  const auth = (req: ReturnType<ReturnType<TestContext['http']>['post']>) =>
    req.set('Authorization', `Bearer ${token}`);
  const create = (body: object) => auth(ctx.http().post('/api/v1/modules')).send(body);

  it('keeps one module when several are created at once for the same room and hour', async () => {
    const period = await createPeriod(ctx.prisma, PERIOD);
    const room = await createRoom(ctx.prisma);
    const teachers = await Promise.all([1, 2, 3, 4, 5].map(() => createTeacher(ctx.prisma)));
    const results = await Promise.all(
      teachers.map((teacher, i) =>
        create({
          periodId: period.id,
          name: `Módulo ${i}`,
          teacherId: teacher.id,
          roomId: room.id,
          schedules: [tuesday],
        }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(4);
    expect(refused.every((r) => r.body.code === 'MODULE_ROOM_CONFLICT')).toBe(true);
    expect(await ctx.prisma.module.count()).toBe(1);
    expect(await ctx.prisma.moduleSchedule.count()).toBe(1);
    // the winner is complete, the losers left nothing behind
    expect(await ctx.prisma.moduleSession.count()).toBe(8);
  });

  it('keeps one module when several are created at once for the same teacher and hour', async () => {
    const period = await createPeriod(ctx.prisma, PERIOD);
    const teacher = await createTeacher(ctx.prisma);
    const rooms = await Promise.all([1, 2, 3].map(() => createRoom(ctx.prisma)));
    const results = await Promise.all(
      rooms.map((room, i) =>
        create({
          periodId: period.id,
          name: `Módulo ${i}`,
          teacherId: teacher.id,
          roomId: room.id,
          schedules: [tuesday],
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(2);
    expect(refused.every((r) => r.body.code === 'MODULE_TEACHER_CONFLICT')).toBe(true);
    expect(await ctx.prisma.module.count()).toBe(1);
  });

  it('never leaves a module in a period that closes at the same moment', async () => {
    for (let round = 0; round < 8; round++) {
      await ctx.reset();
      const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
      const login = await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email: admin.email, password: TEST_PASSWORD });
      token = login.body.accessToken as string;

      const period = await createPeriod(ctx.prisma, { ...PERIOD, status: 'ACTIVE' });
      const teacher = await createTeacher(ctx.prisma);
      const room = await createRoom(ctx.prisma);
      const [created, closed] = await Promise.all([
        create({
          periodId: period.id,
          name: 'Carrera',
          teacherId: teacher.id,
          roomId: room.id,
          schedules: [tuesday],
        }),
        auth(ctx.http().post(`/api/v1/academic-periods/${period.id}/close`)),
      ]);
      expect(closed.status).toBe(200);
      // Either the module was saved whole before the close, or it was refused for the closed period.
      if (created.status === 201) {
        expect(await ctx.prisma.module.count()).toBe(1);
        expect(await ctx.prisma.moduleSession.count()).toBe(8);
      } else {
        expect(created.status).toBe(409);
        expect(created.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
        expect(await ctx.prisma.module.count()).toBe(0);
        expect(await ctx.prisma.moduleSession.count()).toBe(0);
      }
      const after = await ctx.prisma.academicPeriod.findUniqueOrThrow({ where: { id: period.id } });
      expect(after.status).toBe('CLOSED');
    }
  });
});
