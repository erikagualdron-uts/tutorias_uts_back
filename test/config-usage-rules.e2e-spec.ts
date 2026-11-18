import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createModule, createPeriod, createRoom, createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

// FR-018: the configuration rules of spec 006 that depend on modules start blocking for real now
// that modules exist. Modules here are rows in the database; enrolled students are simulated.
describe('configuration rules that depend on modules (spec 006 rules, spec 010 data)', () => {
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

  type Method = 'get' | 'post' | 'patch' | 'delete';
  const call = (method: Method, path: string) =>
    ctx.http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  describe('periods', () => {
    it('does not delete a period that has modules', async () => {
      const period = await createPeriod(ctx.prisma);
      await createModule(ctx.prisma, { periodId: period.id });
      const res = await call('delete', `/academic-periods/${period.id}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERIOD_HAS_MODULES');
    });

    it('reports hasModules and deletes a period once its modules are deleted', async () => {
      const period = await createPeriod(ctx.prisma);
      const module = await createModule(ctx.prisma, { periodId: period.id });
      expect((await call('get', `/academic-periods/${period.id}`)).body.hasModules).toBe(true);
      await ctx.prisma.module.update({ where: { id: module.id }, data: { deletedAt: new Date() } });
      expect((await call('get', `/academic-periods/${period.id}`)).body.hasModules).toBe(false);
      expect((await call('delete', `/academic-periods/${period.id}`)).status).toBe(204);
    });

    it('still deletes an upcoming period without modules', async () => {
      const period = await createPeriod(ctx.prisma);
      expect((await call('delete', `/academic-periods/${period.id}`)).status).toBe(204);
    });
  });

  describe('rooms', () => {
    it('does not deactivate or delete a room with modules in the active period', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const room = await createRoom(ctx.prisma);
      await createModule(ctx.prisma, { periodId: period.id, roomId: room.id });
      for (const res of [
        await call('post', `/rooms/${room.id}/deactivate`),
        await call('delete', `/rooms/${room.id}`),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ROOM_IN_ACTIVE_PERIOD');
      }
      const row = await ctx.prisma.room.findUniqueOrThrow({ where: { id: room.id } });
      expect(row).toMatchObject({ status: 'ACTIVE', deletedAt: null });
    });

    it('allows deactivating a room whose modules are only in upcoming periods and reports how many', async () => {
      const upcoming = await createPeriod(ctx.prisma, { status: 'UPCOMING' });
      const other = await createPeriod(ctx.prisma, {
        status: 'UPCOMING',
        startsOn: '2031-01-01',
        endsOn: '2031-06-30',
      });
      const room = await createRoom(ctx.prisma);
      await createModule(ctx.prisma, { periodId: upcoming.id, roomId: room.id });
      await createModule(ctx.prisma, { periodId: other.id, roomId: room.id });
      const impact = await call('get', `/rooms/${room.id}/impact`);
      expect(impact.body).toEqual({ modulesInActivePeriod: 0, modulesInUpcomingPeriods: 2, maxEnrolled: 0 });
      const res = await call('post', `/rooms/${room.id}/deactivate`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('INACTIVE');
    });

    it('ignores deleted modules and closed periods when counting the use of a room', async () => {
      const active = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const closed = await createPeriod(ctx.prisma, {
        status: 'CLOSED',
        startsOn: '2020-01-01',
        endsOn: '2020-06-30',
      });
      const room = await createRoom(ctx.prisma);
      await createModule(ctx.prisma, { periodId: active.id, roomId: room.id, deletedAt: new Date() });
      await createModule(ctx.prisma, { periodId: closed.id, roomId: room.id });
      const impact = await call('get', `/rooms/${room.id}/impact`);
      expect(impact.body).toEqual({ modulesInActivePeriod: 0, modulesInUpcomingPeriods: 0, maxEnrolled: 0 });
      expect((await call('post', `/rooms/${room.id}/deactivate`)).status).toBe(200);
    });

    it('does not lower the capacity below the students enrolled in a module that uses the room', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const room = await createRoom(ctx.prisma, { capacity: 30 });
      const module = await createModule(ctx.prisma, { periodId: period.id, roomId: room.id });
      ctx.usage.setEnrolled(module.id, 25);
      expect((await call('get', `/rooms/${room.id}/impact`)).body.maxEnrolled).toBe(25);

      const blocked = await call('patch', `/rooms/${room.id}`).send({ capacity: 20 });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('ROOM_CAPACITY_BELOW_ENROLLED');
      expect(blocked.body.details.maxEnrolled).toBe(25);

      expect((await call('patch', `/rooms/${room.id}`).send({ capacity: 25 })).status).toBe(200);
      expect((await call('patch', `/rooms/${room.id}`).send({ capacity: 40 })).status).toBe(200);
    });

    it('uses the most enrolled module when several share the room', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const room = await createRoom(ctx.prisma, { capacity: 50 });
      const small = await createModule(ctx.prisma, {
        periodId: period.id,
        roomId: room.id,
        schedules: [{ dayOfWeek: 1, startMinute: 600, endMinute: 660 }],
      });
      const big = await createModule(ctx.prisma, {
        periodId: period.id,
        roomId: room.id,
        schedules: [{ dayOfWeek: 3, startMinute: 600, endMinute: 660 }],
      });
      ctx.usage.setEnrolled(small.id, 5);
      ctx.usage.setEnrolled(big.id, 33);
      const res = await call('patch', `/rooms/${room.id}`).send({ capacity: 30 });
      expect(res.status).toBe(409);
      expect(res.body.details.maxEnrolled).toBe(33);
    });
  });
});
