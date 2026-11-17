import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PeriodsService } from '../src/periods/periods.service.js';
import { createPeriod, createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('academic periods (US1)', () => {
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

  const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    ctx.http()[method](`/api/v1/academic-periods${path}`).set('Authorization', `Bearer ${token}`);
  const create = (body: object) => api('post', '').send(body);
  const valid = { name: '2030-1', startsOn: '2030-01-15', endsOn: '2030-06-15' };

  it('creates a period as upcoming', async () => {
    const res = await create(valid);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: '2030-1', startsOn: '2030-01-15', endsOn: '2030-06-15', status: 'UPCOMING' });
  });

  it('rejects an end date that is not after the start date', async () => {
    const same = await create({ ...valid, endsOn: valid.startsOn });
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('PERIOD_DATES_INVALID');
    const before = await create({ ...valid, endsOn: '2030-01-01' });
    expect(before.body.code).toBe('PERIOD_DATES_INVALID');
    const notADay = await create({ ...valid, endsOn: '2030-02-31' });
    expect(notADay.body.code).toBe('PERIOD_DATES_INVALID');
  });

  it('rejects a duplicate name ignoring case and spaces, but frees the name after a logical delete', async () => {
    await create(valid);
    const dup = await create({ name: '  2030-1 ', startsOn: '2031-01-01', endsOn: '2031-06-01' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PERIOD_NAME_TAKEN');
    const first = await ctx.prisma.academicPeriod.findFirstOrThrow({ where: { name: '2030-1' } });
    expect((await api('delete', `/${first.id}`)).status).toBe(204);
    expect((await create({ name: '2030-1', startsOn: '2031-01-01', endsOn: '2031-06-01' })).status).toBe(201);
  });

  it('rejects overlapping dates, including an end equal to another start, and names the clash', async () => {
    await create(valid);
    const inside = await create({ name: 'X', startsOn: '2030-03-01', endsOn: '2030-04-01' });
    expect(inside.status).toBe(409);
    expect(inside.body.code).toBe('PERIOD_DATES_OVERLAP');
    expect(inside.body.details.overlappingPeriod).toMatchObject({ name: '2030-1' });
    const touching = await create({ name: 'Y', startsOn: '2030-06-15', endsOn: '2030-12-15' });
    expect(touching.body.code).toBe('PERIOD_DATES_OVERLAP');
    expect((await create({ name: 'Z', startsOn: '2030-06-16', endsOn: '2030-12-15' })).status).toBe(201);
  });

  it('lists with a status filter', async () => {
    await createPeriod(ctx.prisma, { name: 'A', startsOn: '2030-01-01', endsOn: '2030-02-01', status: 'CLOSED' });
    await createPeriod(ctx.prisma, { name: 'B', startsOn: '2030-03-01', endsOn: '2030-04-01' });
    const all = await api('get', '');
    expect(all.body.meta.total).toBe(2);
    const closed = await api('get', '?status=CLOSED');
    expect(closed.body.data.map((p: { name: string }) => p.name)).toEqual(['A']);
  });

  describe('activation', () => {
    it('activates without confirmation when none is active', async () => {
      const p = await createPeriod(ctx.prisma);
      const res = await api('post', `/${p.id}/activate`).send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ACTIVE');
      expect((await api('get', '/active')).body.id).toBe(p.id);
    });

    it('asks for confirmation when another period is active, then closes it atomically', async () => {
      const first = await createPeriod(ctx.prisma, { name: 'A', startsOn: '2030-01-01', endsOn: '2030-02-01', status: 'ACTIVE' });
      const second = await createPeriod(ctx.prisma, { name: 'B', startsOn: '2030-03-01', endsOn: '2030-04-01' });
      const refused = await api('post', `/${second.id}/activate`).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('PERIOD_ACTIVE_EXISTS');
      expect(refused.body.details.activePeriod.name).toBe('A');
      const done = await api('post', `/${second.id}/activate`).send({ confirmCloseActive: true });
      expect(done.body.status).toBe('ACTIVE');
      const closed = await ctx.prisma.academicPeriod.findUniqueOrThrow({ where: { id: first.id } });
      expect(closed).toMatchObject({ status: 'CLOSED', closedBy: 'MANUAL' });
    });

    it('never leaves two active periods when activations race', async () => {
      const a = await createPeriod(ctx.prisma, { name: 'A', startsOn: '2030-01-01', endsOn: '2030-02-01' });
      const b = await createPeriod(ctx.prisma, { name: 'B', startsOn: '2030-03-01', endsOn: '2030-04-01' });
      const results = await Promise.all([
        api('post', `/${a.id}/activate`).send({}),
        api('post', `/${b.id}/activate`).send({}),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const active = await ctx.prisma.academicPeriod.count({ where: { status: 'ACTIVE' } });
      expect(active).toBe(1);
    });

    it('refuses to activate a period whose end date has passed or that is not upcoming', async () => {
      const past = await createPeriod(ctx.prisma, { name: 'Old', startsOn: '2020-01-01', endsOn: '2020-06-01' });
      expect((await api('post', `/${past.id}/activate`).send({})).body.code).toBe('PERIOD_ALREADY_ENDED');
      const closed = await createPeriod(ctx.prisma, { name: 'C', startsOn: '2031-01-01', endsOn: '2031-02-01', status: 'CLOSED' });
      expect((await api('post', `/${closed.id}/activate`).send({})).body.code).toBe('PERIOD_NOT_UPCOMING');
    });
  });

  describe('closing', () => {
    it('closes the active period manually', async () => {
      const p = await createPeriod(ctx.prisma, { status: 'ACTIVE' });
      const res = await api('post', `/${p.id}/close`);
      expect(res.body).toMatchObject({ status: 'CLOSED', closedBy: 'MANUAL' });
      expect((await api('post', `/${p.id}/close`)).body.code).toBe('PERIOD_NOT_ACTIVE');
    });

    it('closes the active period automatically once its last day ends in Bogota', async () => {
      const p = await createPeriod(ctx.prisma, { startsOn: '2030-01-01', endsOn: '2030-01-10', status: 'ACTIVE' });
      expect((await api('get', '/active')).status).toBe(200);
      const periods = ctx.app.get(PeriodsService);
      // one minute before the end of Jan 10 in Bogota (05:00 UTC of Jan 11): still open
      ctx.clock.advance(new Date('2030-01-11T04:59:00Z').getTime() - Date.now());
      expect(await periods.closeExpired()).toBe(0);
      // the same call the scheduled task makes, once the day has ended
      ctx.clock.advance(60_000);
      expect(await periods.closeExpired()).toBe(1);
      expect(await periods.closeExpired()).toBe(0);
      const row = await ctx.prisma.academicPeriod.findUniqueOrThrow({ where: { id: p.id } });
      expect(row).toMatchObject({ status: 'CLOSED', closedBy: 'AUTOMATIC' });
    });
  });

  describe('editing', () => {
    it('edits name and dates of an upcoming and an active period', async () => {
      const up = await createPeriod(ctx.prisma, { name: 'U', startsOn: '2030-01-01', endsOn: '2030-02-01' });
      expect((await api('patch', `/${up.id}`).send({ name: 'U2' })).body.name).toBe('U2');
      const act = await createPeriod(ctx.prisma, { name: 'A', startsOn: '2031-01-01', endsOn: '2031-02-01', status: 'ACTIVE' });
      const res = await api('patch', `/${act.id}`).send({ endsOn: '2031-03-01' });
      expect(res.status).toBe(200);
      expect(res.body.endsOn).toBe('2031-03-01');
    });

    it('rejects ending an active period before today and overlapping edits', async () => {
      const act = await createPeriod(ctx.prisma, { name: 'A', startsOn: '2020-01-01', endsOn: '2099-01-01', status: 'ACTIVE' });
      const early = await api('patch', `/${act.id}`).send({ endsOn: '2020-06-01' });
      expect(early.body.code).toBe('PERIOD_DATES_INVALID');
      await createPeriod(ctx.prisma, { name: 'N', startsOn: '2100-01-01', endsOn: '2100-06-01' });
      const clash = await api('patch', `/${act.id}`).send({ endsOn: '2100-02-01' });
      expect(clash.body.code).toBe('PERIOD_DATES_OVERLAP');
    });

    it('keeps a closed period read-only', async () => {
      const p = await createPeriod(ctx.prisma, { status: 'CLOSED' });
      const res = await api('patch', `/${p.id}`).send({ name: 'Nope' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PERIOD_CLOSED_READ_ONLY');
    });
  });

  describe('deleting', () => {
    it('deletes an upcoming period logically and keeps the row (SC-003)', async () => {
      const p = await createPeriod(ctx.prisma);
      expect((await api('delete', `/${p.id}`)).status).toBe(204);
      const row = await ctx.prisma.academicPeriod.findUniqueOrThrow({ where: { id: p.id } });
      expect(row.deletedAt).not.toBeNull();
      expect((await api('get', `/${p.id}`)).status).toBe(404);
    });

    it('blocks deleting a period with modules, an active one and a closed one', async () => {
      const withModules = await createPeriod(ctx.prisma, { name: 'M', startsOn: '2030-01-01', endsOn: '2030-02-01' });
      ctx.usage.modulesInPeriod = 3;
      expect((await api('delete', `/${withModules.id}`)).body.code).toBe('PERIOD_HAS_MODULES');
      ctx.usage.modulesInPeriod = 0;
      const act = await createPeriod(ctx.prisma, { name: 'A', startsOn: '2031-01-01', endsOn: '2031-02-01', status: 'ACTIVE' });
      expect((await api('delete', `/${act.id}`)).body.code).toBe('PERIOD_NOT_UPCOMING');
      const closed = await createPeriod(ctx.prisma, { name: 'C', startsOn: '2032-01-01', endsOn: '2032-02-01', status: 'CLOSED' });
      expect((await api('delete', `/${closed.id}`)).body.code).toBe('PERIOD_NOT_UPCOMING');
    });
  });

  describe('database constraints', () => {
    it('refuses two active periods and overlapping ranges even when inserted directly', async () => {
      await createPeriod(ctx.prisma, { name: 'A', startsOn: '2030-01-01', endsOn: '2030-02-01', status: 'ACTIVE' });
      await expect(
        createPeriod(ctx.prisma, { name: 'B', startsOn: '2030-03-01', endsOn: '2030-04-01', status: 'ACTIVE' }),
      ).rejects.toThrow();
      await expect(
        createPeriod(ctx.prisma, { name: 'C', startsOn: '2030-01-15', endsOn: '2030-03-01' }),
      ).rejects.toThrow();
    });
  });
});
