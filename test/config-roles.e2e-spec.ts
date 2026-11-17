import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocation,
  createPeriod,
  createRoom,
  createUser,
  TEST_PASSWORD,
} from './utils/factories.js';
import { createTestApp, PQRS_ITEM_IDS, type TestContext } from './utils/test-app.js';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

describe('CAE configuration access (US4)', () => {
  let ctx: TestContext;
  let ids: { period: string; location: string; room: string };

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    const location = await createLocation(ctx.prisma);
    ids = {
      period: (await createPeriod(ctx.prisma)).id,
      location: location.id,
      room: (await createRoom(ctx.prisma, { locationId: location.id })).id,
    };
  });
  afterAll(() => ctx.close());

  const tokenOf = async (role: 'SUPERADMIN' | 'TEACHER' | 'STUDENT') => {
    const user = await createUser(ctx.prisma, { role });
    const res = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  };

  // Every endpoint of specs/006-cae-configuration/contracts/config-api.yaml.
  // `open` marks the two reads that any signed-in role may do.
  const endpoints = (): { method: Method; path: string; open?: boolean }[] => [
    { method: 'get', path: '/academic-periods' },
    { method: 'post', path: '/academic-periods' },
    { method: 'get', path: '/academic-periods/active', open: true },
    { method: 'get', path: `/academic-periods/${ids.period}` },
    { method: 'patch', path: `/academic-periods/${ids.period}` },
    { method: 'post', path: `/academic-periods/${ids.period}/activate` },
    { method: 'post', path: `/academic-periods/${ids.period}/close` },
    { method: 'delete', path: `/academic-periods/${ids.period}` },
    { method: 'get', path: '/locations' },
    { method: 'post', path: '/locations' },
    { method: 'get', path: `/locations/${ids.location}` },
    { method: 'patch', path: `/locations/${ids.location}` },
    { method: 'delete', path: `/locations/${ids.location}` },
    { method: 'get', path: '/rooms' },
    { method: 'post', path: '/rooms' },
    { method: 'get', path: `/rooms/${ids.room}` },
    { method: 'patch', path: `/rooms/${ids.room}` },
    { method: 'get', path: `/rooms/${ids.room}/impact` },
    { method: 'post', path: `/rooms/${ids.room}/deactivate` },
    { method: 'post', path: `/rooms/${ids.room}/reactivate` },
    { method: 'delete', path: `/rooms/${ids.room}` },
    { method: 'get', path: '/dropdown-lists' },
    { method: 'get', path: '/dropdown-lists/PQRS_TYPE' },
    { method: 'get', path: '/dropdown-lists/PQRS_TYPE/items', open: true },
    { method: 'post', path: '/dropdown-lists/PQRS_TYPE/items' },
    { method: 'put', path: '/dropdown-lists/PQRS_TYPE/items/order' },
    { method: 'patch', path: `/dropdown-lists/PQRS_TYPE/items/${PQRS_ITEM_IDS[0]}` },
    { method: 'delete', path: `/dropdown-lists/PQRS_TYPE/items/${PQRS_ITEM_IDS[0]}` },
  ];

  const snapshot = async () => ({
    periods: await ctx.prisma.academicPeriod.findMany({ orderBy: { id: 'asc' } }),
    locations: await ctx.prisma.location.findMany({ orderBy: { id: 'asc' } }),
    rooms: await ctx.prisma.room.findMany({ orderBy: { id: 'asc' } }),
    items: await ctx.prisma.dropdownItem.findMany({ orderBy: { id: 'asc' } }),
  });

  it.each(['TEACHER', 'STUDENT'] as const)(
    'denies %s every administration endpoint and changes nothing',
    async (role) => {
      const token = await tokenOf(role);
      const before = await snapshot();
      for (const { method, path, open } of endpoints()) {
        const res = await ctx.http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`).send({});
        if (open) {
          expect(res.status, `${method} ${path}`).not.toBe(403);
          continue;
        }
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN_ROLE');
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it('lets any signed-in role read the active period and the active items of a list', async () => {
    await ctx.prisma.academicPeriod.update({ where: { id: ids.period }, data: { status: 'ACTIVE' } });
    for (const role of ['TEACHER', 'STUDENT'] as const) {
      const token = await tokenOf(role);
      const period = await ctx.http().get('/api/v1/academic-periods/active').set('Authorization', `Bearer ${token}`);
      expect(period.status).toBe(200);
      const items = await ctx
        .http()
        .get('/api/v1/dropdown-lists/PQRS_TYPE/items')
        .set('Authorization', `Bearer ${token}`);
      expect(items.status).toBe(200);
      expect(items.body).toHaveLength(4);
    }
  });

  it('rejects requests without a token on every endpoint', async () => {
    for (const { method, path } of endpoints()) {
      const res = await ctx.http()[method](`/api/v1${path}`).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('lets the CAE read every listing', async () => {
    const token = await tokenOf('SUPERADMIN');
    for (const path of ['/academic-periods', '/locations', '/rooms', '/dropdown-lists', '/dropdown-lists/PQRS_TYPE']) {
      const res = await ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);
      expect(res.status, path).toBe(200);
    }
  });
});
