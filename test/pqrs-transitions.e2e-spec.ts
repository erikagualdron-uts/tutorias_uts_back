import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPqrs, createPqrsMessage, createStudent } from './utils/factories.js';
import { adminCaller } from './utils/pqrs.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('the CAE moves a PQRS forward (spec 017, story 3)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const setup = async (status: 'FILED' | 'IN_REVIEW' | 'RESOLVED', replies = 0) => {
    const cae = await adminCaller(ctx);
    const author = await createStudent(ctx.prisma);
    const pqrs = await createPqrs(ctx.prisma, { authorId: author.id, status });
    for (let i = 0; i < replies; i += 1) await createPqrsMessage(ctx.prisma, pqrs.id, cae.user.id, `Respuesta ${i + 1}`);
    return { cae, pqrs };
  };
  const status = async (id: string) => (await ctx.prisma.pqrs.findUniqueOrThrow({ where: { id } })).status;

  describe('review', () => {
    it('moves a FILED PQRS to IN_REVIEW and stamps reviewedAt', async () => {
      const { cae, pqrs } = await setup('FILED');
      const res = await cae.post(`/pqrs/${pqrs.id}/review`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('IN_REVIEW');
      expect(res.body.reviewedAt).not.toBeNull();
      expect(await status(pqrs.id)).toBe('IN_REVIEW');
    });

    it.each(['IN_REVIEW', 'RESOLVED'] as const)('answers 409 PQRS_INVALID_TRANSITION from %s', async (from) => {
      const { cae, pqrs } = await setup(from);
      const res = await cae.post(`/pqrs/${pqrs.id}/review`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PQRS_INVALID_TRANSITION');
      expect(await status(pqrs.id)).toBe(from);
    });

    it('answers 404 PQRS_NOT_FOUND for an unknown PQRS', async () => {
      const cae = await adminCaller(ctx);
      const res = await cae.post(`/pqrs/${crypto.randomUUID()}/review`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PQRS_NOT_FOUND');
    });
  });

  describe('respond', () => {
    it('adds a reply with author and date to a PQRS in review', async () => {
      const { cae, pqrs } = await setup('IN_REVIEW');
      const res = await cae.post(`/pqrs/${pqrs.id}/responses`, { body: '  Ya lo revisamos.  ' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ body: 'Ya lo revisamos.' });
      const row = await ctx.prisma.pqrsMessage.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.authorId).toBe(cae.user.id);
      expect(row.pqrsId).toBe(pqrs.id);
    });

    it.each(['FILED', 'RESOLVED'] as const)('answers 409 PQRS_NOT_IN_REVIEW on a %s PQRS and stores nothing', async (from) => {
      const { cae, pqrs } = await setup(from);
      const res = await cae.post(`/pqrs/${pqrs.id}/responses`, { body: 'Hola' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PQRS_NOT_IN_REVIEW');
      expect(await ctx.prisma.pqrsMessage.count({ where: { pqrsId: pqrs.id } })).toBe(0);
    });

    it('rejects an empty reply and one above the configured limit', async () => {
      const { cae, pqrs } = await setup('IN_REVIEW');
      for (const body of ['', '   ', 'a'.repeat(2001)]) {
        const res = await cae.post(`/pqrs/${pqrs.id}/responses`, { body });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect((await cae.post(`/pqrs/${pqrs.id}/responses`, { body: 'a'.repeat(2000) })).status).toBe(201);
    });
  });

  describe('resolve', () => {
    it('resolves an IN_REVIEW PQRS with at least one reply and stamps resolvedAt', async () => {
      const { cae, pqrs } = await setup('IN_REVIEW', 1);
      const res = await cae.post(`/pqrs/${pqrs.id}/resolve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('RESOLVED');
      expect(res.body.resolvedAt).not.toBeNull();
    });

    it('answers 409 PQRS_RESPONSE_REQUIRED when an IN_REVIEW PQRS has no reply', async () => {
      const { cae, pqrs } = await setup('IN_REVIEW');
      const res = await cae.post(`/pqrs/${pqrs.id}/resolve`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PQRS_RESPONSE_REQUIRED');
      expect(await status(pqrs.id)).toBe('IN_REVIEW');
    });

    it('does not count a deleted reply', async () => {
      const { cae, pqrs } = await setup('IN_REVIEW', 1);
      await ctx.prisma.pqrsMessage.updateMany({ where: { pqrsId: pqrs.id }, data: { deletedAt: new Date() } });
      expect((await cae.post(`/pqrs/${pqrs.id}/resolve`)).body.code).toBe('PQRS_RESPONSE_REQUIRED');
    });

    it.each(['FILED', 'RESOLVED'] as const)('answers 409 PQRS_INVALID_TRANSITION from %s, even with replies', async (from) => {
      const { cae, pqrs } = await setup(from, 1);
      const res = await cae.post(`/pqrs/${pqrs.id}/resolve`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PQRS_INVALID_TRANSITION');
      expect(await status(pqrs.id)).toBe(from);
    });
  });

  it('walks the whole flow and leaves RESOLVED final', async () => {
    const { cae, pqrs } = await setup('FILED');
    expect((await cae.post(`/pqrs/${pqrs.id}/review`)).status).toBe(200);
    expect((await cae.post(`/pqrs/${pqrs.id}/responses`, { body: 'Respuesta' })).status).toBe(201);
    expect((await cae.post(`/pqrs/${pqrs.id}/resolve`)).status).toBe(200);
    expect((await cae.post(`/pqrs/${pqrs.id}/review`)).body.code).toBe('PQRS_INVALID_TRANSITION');
    expect((await cae.post(`/pqrs/${pqrs.id}/resolve`)).body.code).toBe('PQRS_INVALID_TRANSITION');
    expect((await cae.post(`/pqrs/${pqrs.id}/responses`, { body: 'Tarde' })).body.code).toBe('PQRS_NOT_IN_REVIEW');
  });

  it('lets only one of two simultaneous resolutions win', async () => {
    const { cae, pqrs } = await setup('IN_REVIEW', 1);
    const results = await Promise.all([cae.post(`/pqrs/${pqrs.id}/resolve`), cae.post(`/pqrs/${pqrs.id}/resolve`)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await ctx.prisma.outboxEvent.count({ where: { pqrsId: pqrs.id, type: 'PQRS_RESOLVED' } })).toBe(1);
  });

  it('never leaves a reply on a resolved PQRS when replying and resolving run together', async () => {
    const { cae, pqrs } = await setup('IN_REVIEW', 1);
    await Promise.all([cae.post(`/pqrs/${pqrs.id}/responses`, { body: 'Extra' }), cae.post(`/pqrs/${pqrs.id}/resolve`)]);
    const resolved = await ctx.prisma.pqrs.findUniqueOrThrow({ where: { id: pqrs.id } });
    expect(resolved.status).toBe('RESOLVED');
    const late = await ctx.prisma.pqrsMessage.count({ where: { pqrsId: pqrs.id, createdAt: { gt: resolved.resolvedAt! } } });
    expect(late).toBe(0);
  });

  it('records one event per action, about the PQRS and with only its id in the payload', async () => {
    const { cae, pqrs } = await setup('FILED');
    await cae.post(`/pqrs/${pqrs.id}/review`);
    await cae.post(`/pqrs/${pqrs.id}/responses`, { body: 'Texto privado de la respuesta' });
    await cae.post(`/pqrs/${pqrs.id}/resolve`);
    const events = await ctx.prisma.outboxEvent.findMany({ where: { pqrsId: pqrs.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['PQRS_IN_REVIEW', 'PQRS_RESPONDED', 'PQRS_RESOLVED']);
    for (const event of events) {
      expect(event.moduleId).toBeNull();
      expect(event.payload).toEqual({ pqrsId: pqrs.id });
    }
  });

  it('records no event for a refused action', async () => {
    const { cae, pqrs } = await setup('FILED');
    await cae.post(`/pqrs/${pqrs.id}/resolve`);
    await cae.post(`/pqrs/${pqrs.id}/responses`, { body: 'No' });
    expect(await ctx.prisma.outboxEvent.count({ where: { pqrsId: pqrs.id } })).toBe(0);
  });
});
