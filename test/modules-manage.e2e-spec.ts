import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHoliday,
  createModule,
  createPeriod,
  createRoom,
  createSession,
  createTeacher,
  createUser,
  TEST_PASSWORD,
} from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const DAY = 86_400_000;
const UUID_NONE = '00000000-0000-4000-8000-000000000999';

async function adminToken(ctx: TestContext) {
  const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
  const res = await ctx.http().post('/api/v1/auth/login').send({ email: admin.email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe('modules: consult (US2)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    token = await adminToken(ctx);
  });
  afterAll(() => ctx.close());

  const get = (path: string) => ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
  const names = (res: { body: { data: { name: string }[] } }) => res.body.data.map((m) => m.name);

  describe('list', () => {
    it('defaults to the active period, then to the nearest upcoming one, then to nothing', async () => {
      expect((await get('/modules')).body).toMatchObject({ data: [], meta: { total: 0 } });
      const far = await createPeriod(ctx.prisma, { startsOn: '2032-01-05', endsOn: '2032-06-30' });
      const near = await createPeriod(ctx.prisma, { startsOn: '2031-01-06', endsOn: '2031-06-30' });
      await createModule(ctx.prisma, { periodId: far.id, name: 'Lejano' });
      await createModule(ctx.prisma, { periodId: near.id, name: 'Cercano' });
      expect(names(await get('/modules'))).toEqual(['Cercano']);

      const active = await createPeriod(ctx.prisma, { status: 'ACTIVE', startsOn: '2030-01-07', endsOn: '2030-06-30' });
      await createModule(ctx.prisma, { periodId: active.id, name: 'Activo' });
      const res = await get('/modules');
      expect(names(res)).toEqual(['Activo']);
      expect(res.body.meta.periodId).toBe(active.id);
      expect(names(await get(`/modules?periodId=${far.id}`))).toEqual(['Lejano']);
    });

    it('returns the summary of each module with cupo and enrolled', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const room = await createRoom(ctx.prisma, { capacity: 25 });
      const module = await createModule(ctx.prisma, { periodId: period.id, roomId: room.id, name: 'Cálculo' });
      ctx.usage.setEnrolled(module.id, 7);
      const [item] = (await get('/modules')).body.data;
      expect(item).toMatchObject({
        id: module.id,
        name: 'Cálculo',
        periodStatus: 'ACTIVE',
        capacity: 25,
        enrolled: 7,
        schedules: [{ dayOfWeek: 2, startTime: '14:00', endTime: '16:00' }],
        roomUnavailable: false,
        teacherUnavailable: false,
      });
      expect(item.room).toMatchObject({ id: room.id, capacity: 25 });
      expect(item.teacher.id).toBe(module.teacherId);
    });

    it('filters by name, teacher and room, paginates and hides deleted modules', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const teacher = await createTeacher(ctx.prisma);
      const room = await createRoom(ctx.prisma);
      const slot = (day: number) => [{ dayOfWeek: day, startMinute: 600, endMinute: 660 }];
      await createModule(ctx.prisma, { periodId: period.id, teacherId: teacher.id, roomId: room.id, name: 'Álgebra', schedules: slot(1) });
      await createModule(ctx.prisma, { periodId: period.id, name: 'Física', schedules: slot(2) });
      await createModule(ctx.prisma, { periodId: period.id, name: 'Química', schedules: slot(3) });
      await createModule(ctx.prisma, { periodId: period.id, name: 'Borrado', deletedAt: new Date() });
      expect(names(await get('/modules?search=ÁLGE'))).toEqual(['Álgebra']);
      expect(names(await get(`/modules?teacherId=${teacher.id}`))).toEqual(['Álgebra']);
      expect(names(await get(`/modules?roomId=${room.id}`))).toEqual(['Álgebra']);
      const second = await get('/modules?limit=2&page=2');
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta).toMatchObject({ page: 2, limit: 2, total: 3 });
      expect((await get('/modules?teacherId=abc')).status).toBe(400);
    });
  });

  describe('detail', () => {
    it('shows enrolled students and blocks schedule changes and deletion while there are some', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const module = await createModule(ctx.prisma, { periodId: period.id });
      expect((await get(`/modules/${module.id}`)).body).toMatchObject({ enrolled: 0, canChangeSchedules: true, canDelete: true });
      ctx.usage.setEnrolled(module.id, 3);
      expect((await get(`/modules/${module.id}`)).body).toMatchObject({ enrolled: 3, canChangeSchedules: false, canDelete: false });
    });

    it('marks a room or a teacher that is no longer available and keeps the module', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const room = await createRoom(ctx.prisma);
      const teacher = await createTeacher(ctx.prisma);
      const module = await createModule(ctx.prisma, { periodId: period.id, roomId: room.id, teacherId: teacher.id });
      await ctx.prisma.room.update({ where: { id: room.id }, data: { status: 'INACTIVE' } });
      await ctx.prisma.user.update({ where: { id: teacher.id }, data: { status: 'INACTIVE' } });
      expect((await get(`/modules/${module.id}`)).body).toMatchObject({ roomUnavailable: true, teacherUnavailable: true });
      expect((await get('/modules')).body.data[0]).toMatchObject({ roomUnavailable: true, teacherUnavailable: true });
    });

    it('is read-only in a closed period', async () => {
      const period = await createPeriod(ctx.prisma, { status: 'CLOSED', startsOn: '2020-01-06', endsOn: '2020-03-01' });
      const module = await createModule(ctx.prisma, { periodId: period.id });
      expect((await get(`/modules/${module.id}`)).body).toMatchObject({
        periodStatus: 'CLOSED',
        readOnlyReason: 'PERIOD_CLOSED',
        canChangeSchedules: false,
        canDelete: false,
      });
    });

    it('lists the future holidays that fall on the days of the module', async () => {
      const period = await createPeriod(ctx.prisma, { startsOn: '2030-01-07', endsOn: '2030-03-03' });
      const module = await createModule(ctx.prisma, { periodId: period.id });
      await createHoliday(ctx.prisma, { date: '2030-01-22' });
      await createHoliday(ctx.prisma, { date: '2030-01-23' });
      await createHoliday(ctx.prisma, { date: '2030-02-05', deletedAt: new Date() });
      expect((await get(`/modules/${module.id}`)).body.holidayDates).toEqual(['2030-01-22']);
    });

    it('answers 404 for a module that does not exist or was deleted', async () => {
      const gone = await createModule(ctx.prisma, { deletedAt: new Date() });
      for (const id of [gone.id, UUID_NONE]) {
        expect((await get(`/modules/${id}`)).status).toBe(404);
        expect((await get(`/modules/${id}/sessions`)).status).toBe(404);
      }
    });
  });

  describe('sessions', () => {
    async function withSessions() {
      const period = await createPeriod(ctx.prisma, { startsOn: '2030-01-07', endsOn: '2030-03-03' });
      const module = await createModule(ctx.prisma, { periodId: period.id });
      for (const [day, status] of [['2030-01-08', 'SCHEDULED'], ['2030-01-15', 'SCHEDULED'], ['2030-01-22', 'CANCELLED']] as const) {
        await createSession(ctx.prisma, {
          moduleId: module.id,
          scheduleId: module.schedules[0]!.id,
          teacherId: module.teacherId,
          roomId: module.roomId,
          startsAt: new Date(`${day}T19:00:00Z`), // 14:00 in Bogota
          status,
        });
      }
      return module;
    }

    it('lists them by start with status, teacher and room', async () => {
      const module = await withSessions();
      const res = await get(`/modules/${module.id}/sessions`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((s: { startsAt: string }) => s.startsAt)).toEqual([
        '2030-01-08T19:00:00.000Z',
        '2030-01-15T19:00:00.000Z',
        '2030-01-22T19:00:00.000Z',
      ]);
      expect(res.body.data[0]).toMatchObject({
        endsAt: '2030-01-08T21:00:00.000Z',
        status: 'SCHEDULED',
        cancelReason: null,
        teacher: { id: module.teacherId },
        room: { id: module.roomId },
      });
      expect(res.body.data[2]).toMatchObject({ status: 'CANCELLED', cancelReason: 'HOLIDAY' });
      expect(res.body.meta.total).toBe(3);
    });

    it('filters by Bogota dates and paginates', async () => {
      const module = await withSessions();
      const range = await get(`/modules/${module.id}/sessions?from=2030-01-15&to=2030-01-15`);
      expect(range.body.data.map((s: { startsAt: string }) => s.startsAt)).toEqual(['2030-01-15T19:00:00.000Z']);
      expect((await get(`/modules/${module.id}/sessions?limit=2&page=2`)).body.data).toHaveLength(1);
      expect((await get(`/modules/${module.id}/sessions?from=2030-02-30`)).status).toBe(400);
    });

    it('hides sessions that were deleted', async () => {
      const module = await withSessions();
      await ctx.prisma.moduleSession.updateMany({ where: { moduleId: module.id }, data: { deletedAt: new Date() } });
      expect((await get(`/modules/${module.id}/sessions`)).body.data).toEqual([]);
    });
  });
});

describe('modules: change room (US3)', () => {
  let ctx: TestContext;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    token = await adminToken(ctx);
  });
  afterAll(() => ctx.close());

  const change = (id: string, body: object) =>
    ctx.http().patch(`/api/v1/modules/${id}/room`).set('Authorization', `Bearer ${token}`).send(body);

  async function setup(status: 'UPCOMING' | 'ACTIVE' | 'CLOSED' = 'ACTIVE') {
    const period = await createPeriod(ctx.prisma, { status, startsOn: '2030-01-07', endsOn: '2030-03-03' });
    const room = await createRoom(ctx.prisma, { capacity: 30 });
    const module = await createModule(ctx.prisma, { periodId: period.id, roomId: room.id });
    return { period, room, module };
  }

  it('blocks a room smaller than the enrolled students and shows both numbers', async () => {
    const { module, room } = await setup();
    ctx.usage.setEnrolled(module.id, 25);
    const small = await createRoom(ctx.prisma, { capacity: 20 });
    const res = await change(module.id, { roomId: small.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MODULE_ROOM_CAPACITY_BELOW_ENROLLED');
    expect(res.body.details).toMatchObject({ capacity: 20, enrolled: 25 });
    expect((await ctx.prisma.module.findUniqueOrThrow({ where: { id: module.id } })).roomId).toBe(room.id);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
  });

  it('allows a room with the same or a larger capacity and the cupo follows it', async () => {
    const { module } = await setup();
    ctx.usage.setEnrolled(module.id, 25);
    const equal = await createRoom(ctx.prisma, { capacity: 25 });
    expect((await change(module.id, { roomId: equal.id })).body).toMatchObject({ capacity: 25, enrolled: 25, room: { id: equal.id } });
    const big = await createRoom(ctx.prisma, { capacity: 40 });
    const res = await change(module.id, { roomId: big.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ capacity: 40, room: { id: big.id } });
  });

  it('changes to any available room when nobody is enrolled', async () => {
    const { module } = await setup();
    const tiny = await createRoom(ctx.prisma, { capacity: 1 });
    expect((await change(module.id, { roomId: tiny.id })).status).toBe(200);
  });

  it('moves the future sessions and the slots and leaves the past ones in their room', async () => {
    const { module, room } = await setup();
    const make = (startsAt: Date, status?: 'CANCELLED') =>
      createSession(ctx.prisma, {
        moduleId: module.id,
        scheduleId: module.schedules[0]!.id,
        teacherId: module.teacherId,
        roomId: room.id,
        startsAt,
        status,
      });
    const past = await make(new Date(Date.now() - 7 * DAY));
    const future = await make(new Date(Date.now() + 7 * DAY));
    const cancelled = await make(new Date(Date.now() + 14 * DAY), 'CANCELLED');
    const next = await createRoom(ctx.prisma);
    expect((await change(module.id, { roomId: next.id })).status).toBe(200);
    const roomOf = async (id: string) => (await ctx.prisma.moduleSession.findUniqueOrThrow({ where: { id } })).roomId;
    expect(await roomOf(past.id)).toBe(room.id);
    expect(await roomOf(future.id)).toBe(next.id);
    expect(await roomOf(cancelled.id)).toBe(next.id);
    expect((await ctx.prisma.moduleSchedule.findUniqueOrThrow({ where: { id: module.schedules[0]!.id } })).roomId).toBe(next.id);
  });

  it('refuses a room that is busy at that hour and names the module', async () => {
    const { period, module } = await setup();
    const taken = await createRoom(ctx.prisma);
    await createModule(ctx.prisma, {
      periodId: period.id,
      roomId: taken.id,
      name: 'Física',
      schedules: [{ dayOfWeek: 2, startMinute: 900, endMinute: 1020 }],
    });
    const res = await change(module.id, { roomId: taken.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MODULE_ROOM_CONFLICT');
    expect(res.body.details.conflict).toMatchObject({ moduleName: 'Física', startTime: '15:00' });
  });

  it('refuses an inactive or deleted room, answers 404 for unknown ones and 400 without a room', async () => {
    const { module } = await setup();
    for (const overrides of [{ status: 'INACTIVE' as const }, { deletedAt: new Date() }]) {
      const room = await createRoom(ctx.prisma, overrides);
      const res = await change(module.id, { roomId: room.id });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MODULE_ROOM_UNAVAILABLE');
    }
    expect((await change(module.id, { roomId: UUID_NONE })).status).toBe(404);
    expect((await change(UUID_NONE, { roomId: module.roomId })).status).toBe(404);
    expect((await change(module.id, {})).status).toBe(400);
  });

  it('does nothing and records nothing when the room is the same', async () => {
    const { module, room } = await setup();
    expect((await change(module.id, { roomId: room.id })).status).toBe(200);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
  });

  it('is read-only in a closed period', async () => {
    const { module } = await setup('CLOSED');
    const other = await createRoom(ctx.prisma);
    const res = await change(module.id, { roomId: other.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
  });

  it('records MODULE_ROOM_CHANGED with the old and the new room', async () => {
    const { module, room } = await setup();
    ctx.usage.setEnrolled(module.id, 4);
    const next = await createRoom(ctx.prisma);
    await change(module.id, { roomId: next.id });
    const [event] = await ctx.prisma.outboxEvent.findMany();
    expect(event).toMatchObject({ type: 'MODULE_ROOM_CHANGED', moduleId: module.id, processedAt: null });
    expect(event!.payload).toMatchObject({ fromRoomId: room.id, toRoomId: next.id, enrolled: 4 });
  });
});
