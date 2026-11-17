import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocation, createRoom, createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('locations and rooms (US2)', () => {
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

  describe('locations', () => {
    it('creates, renames and lists with room counts', async () => {
      const created = await call('post', '/locations').send({ name: 'Sede Central' });
      expect(created.status).toBe(201);
      expect(created.body.roomCounts).toEqual({ active: 0, inactive: 0 });
      const renamed = await call('patch', `/locations/${created.body.id}`).send({ name: 'Sede Norte' });
      expect(renamed.body.name).toBe('Sede Norte');
      await createRoom(ctx.prisma, { locationId: created.body.id });
      await createRoom(ctx.prisma, { locationId: created.body.id, status: 'INACTIVE' });
      const list = await call('get', '/locations');
      expect(list.body.data[0]).toMatchObject({ name: 'Sede Norte', roomCounts: { active: 1, inactive: 1 } });
    });

    it('rejects duplicate names ignoring case and frees them after a logical delete', async () => {
      await createLocation(ctx.prisma, { name: 'Sede Central' });
      const dup = await call('post', '/locations').send({ name: ' sede central ' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('LOCATION_NAME_TAKEN');
      const gone = await createLocation(ctx.prisma, { name: 'Vieja', deletedAt: new Date() });
      expect(gone.deletedAt).not.toBeNull();
      expect((await call('post', '/locations').send({ name: 'Vieja' })).status).toBe(201);
    });

    it('blocks deleting a location with active rooms and explains it', async () => {
      const room = await createRoom(ctx.prisma);
      const res = await call('delete', `/locations/${room.locationId}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LOCATION_HAS_ACTIVE_ROOMS');
    });

    it('deletes the location and its inactive rooms together, keeping the rows', async () => {
      const location = await createLocation(ctx.prisma);
      const room = await createRoom(ctx.prisma, { locationId: location.id, status: 'INACTIVE' });
      expect((await call('delete', `/locations/${location.id}`)).status).toBe(204);
      const rows = {
        location: await ctx.prisma.location.findUniqueOrThrow({ where: { id: location.id } }),
        room: await ctx.prisma.room.findUniqueOrThrow({ where: { id: room.id } }),
      };
      expect(rows.location.deletedAt).not.toBeNull();
      expect(rows.room.deletedAt).not.toBeNull();
    });

    it('blocks the cascade when an inactive room has modules in the active period', async () => {
      const location = await createLocation(ctx.prisma);
      await createRoom(ctx.prisma, { locationId: location.id, status: 'INACTIVE' });
      ctx.usage.roomUsage = { modulesInActivePeriod: 1, modulesInUpcomingPeriods: 0, maxEnrolled: 0 };
      const res = await call('delete', `/locations/${location.id}`);
      expect(res.body.code).toBe('ROOM_IN_ACTIVE_PERIOD');
      const still = await ctx.prisma.location.findUniqueOrThrow({ where: { id: location.id } });
      expect(still.deletedAt).toBeNull();
    });
  });

  describe('rooms', () => {
    it('creates a room as active with its location', async () => {
      const location = await createLocation(ctx.prisma, { name: 'Sede Central' });
      const res = await call('post', '/rooms').send({ locationId: location.id, name: 'A-101', capacity: 30 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'A-101', capacity: 30, status: 'ACTIVE', locationName: 'Sede Central' });
    });

    it('rejects empty, zero, negative and decimal capacities with ROOM_CAPACITY_INVALID', async () => {
      const location = await createLocation(ctx.prisma);
      for (const capacity of [0, -5, 2.5]) {
        const res = await call('post', '/rooms').send({ locationId: location.id, name: `R${capacity}`, capacity });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('ROOM_CAPACITY_INVALID');
      }
      const missing = await call('post', '/rooms').send({ locationId: location.id, name: 'R' });
      expect(missing.status).toBe(400);
    });

    it('keeps names unique per location only', async () => {
      const a = await createLocation(ctx.prisma);
      const b = await createLocation(ctx.prisma);
      await createRoom(ctx.prisma, { locationId: a.id, name: 'A-101' });
      const dup = await call('post', '/rooms').send({ locationId: a.id, name: 'a-101', capacity: 10 });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('ROOM_NAME_TAKEN');
      expect((await call('post', '/rooms').send({ locationId: b.id, name: 'A-101', capacity: 10 })).status).toBe(201);
    });

    it('refuses a room in a missing or deleted location', async () => {
      const gone = await createLocation(ctx.prisma, { deletedAt: new Date() });
      const res = await call('post', '/rooms').send({ locationId: gone.id, name: 'X', capacity: 10 });
      expect(res.status).toBe(404);
    });

    it('deactivates and reactivates keeping the data', async () => {
      const room = await createRoom(ctx.prisma, { capacity: 40 });
      const off = await call('post', `/rooms/${room.id}/deactivate`);
      expect(off.body).toMatchObject({ status: 'INACTIVE', capacity: 40 });
      const on = await call('post', `/rooms/${room.id}/reactivate`);
      expect(on.body).toMatchObject({ status: 'ACTIVE', capacity: 40 });
    });

    it('blocks deactivating and deleting a room with modules in the active period', async () => {
      const room = await createRoom(ctx.prisma);
      ctx.usage.roomUsage = { modulesInActivePeriod: 2, modulesInUpcomingPeriods: 0, maxEnrolled: 0 };
      expect((await call('post', `/rooms/${room.id}/deactivate`)).body.code).toBe('ROOM_IN_ACTIVE_PERIOD');
      expect((await call('delete', `/rooms/${room.id}`)).body.code).toBe('ROOM_IN_ACTIVE_PERIOD');
    });

    it('allows deactivating with modules only in upcoming periods and reports them in impact', async () => {
      const room = await createRoom(ctx.prisma);
      ctx.usage.roomUsage = { modulesInActivePeriod: 0, modulesInUpcomingPeriods: 3, maxEnrolled: 0 };
      const impact = await call('get', `/rooms/${room.id}/impact`);
      expect(impact.body.modulesInUpcomingPeriods).toBe(3);
      expect((await call('post', `/rooms/${room.id}/deactivate`)).status).toBe(200);
    });

    it('refuses lowering the capacity below the enrolled students', async () => {
      const room = await createRoom(ctx.prisma, { capacity: 30 });
      ctx.usage.roomUsage = { modulesInActivePeriod: 0, modulesInUpcomingPeriods: 0, maxEnrolled: 25 };
      const low = await call('patch', `/rooms/${room.id}`).send({ capacity: 20 });
      expect(low.status).toBe(409);
      expect(low.body.code).toBe('ROOM_CAPACITY_BELOW_ENROLLED');
      expect((await call('patch', `/rooms/${room.id}`).send({ capacity: 25 })).body.capacity).toBe(25);
    });

    it('deletes logically and keeps the row', async () => {
      const room = await createRoom(ctx.prisma);
      expect((await call('delete', `/rooms/${room.id}`)).status).toBe(204);
      const row = await ctx.prisma.room.findUniqueOrThrow({ where: { id: room.id } });
      expect(row.deletedAt).not.toBeNull();
      expect((await call('get', `/rooms/${room.id}`)).status).toBe(404);
    });

    it('searches by name and filters by location and status', async () => {
      const a = await createLocation(ctx.prisma, { name: 'A' });
      const b = await createLocation(ctx.prisma, { name: 'B' });
      await createRoom(ctx.prisma, { locationId: a.id, name: 'Lab 1' });
      await createRoom(ctx.prisma, { locationId: a.id, name: 'Aula 2', status: 'INACTIVE' });
      await createRoom(ctx.prisma, { locationId: b.id, name: 'Lab 3' });
      const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((r) => r.name);
      expect(names(await call('get', '/rooms?search=lab'))).toEqual(['Lab 1', 'Lab 3']);
      expect(names(await call('get', `/rooms?locationId=${a.id}`))).toEqual(['Aula 2', 'Lab 1']);
      expect(names(await call('get', '/rooms?status=INACTIVE'))).toEqual(['Aula 2']);
    });
  });
});
