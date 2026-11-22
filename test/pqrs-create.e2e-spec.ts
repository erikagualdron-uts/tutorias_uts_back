import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPqrsType } from './utils/factories.js';
import { pqrsBody, studentCaller, teacherCaller } from './utils/pqrs.js';
import { createTestApp, PQRS_ITEM_IDS, type TestContext } from './utils/test-app.js';

describe('file a PQRS (spec 017, story 1)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it.each([
    ['student', studentCaller],
    ['teacher', teacherCaller],
  ] as const)('a %s files a PQRS that starts FILED, with the type labels in both languages', async (_role, caller) => {
    const me = await caller(ctx);
    const res = await me.post('/pqrs', pqrsBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'FILED', subject: 'Horario de tutorías', type: { id: PQRS_ITEM_IDS[0], labelEs: 'Petición', labelEn: 'Request' } });
    expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
    const row = await ctx.prisma.pqrs.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.authorId).toBe(me.user.id);
  });

  it.each([
    ['empty subject', { subject: '' }, 'subject'],
    ['blank subject', { subject: '   ' }, 'subject'],
    ['empty description', { description: '' }, 'description'],
    ['blank description', { description: '  \n ' }, 'description'],
    ['missing type', { typeId: undefined }, 'typeId'],
    ['missing request key', { clientRequestId: undefined }, 'clientRequestId'],
  ])('%s answers 400 VALIDATION_FAILED naming the field', async (_name, change, field) => {
    const me = await studentCaller(ctx);
    const res = await me.post('/pqrs', pqrsBody(change));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details.fields).toHaveProperty(field);
    expect(await ctx.prisma.pqrs.count()).toBe(0);
  });

  it('rejects a subject or a description above the configured limits', async () => {
    const me = await studentCaller(ctx);
    const { body: limits } = await me.get('/pqrs/limits');
    const longSubject = await me.post('/pqrs', pqrsBody({ subject: 'a'.repeat(limits.subjectMaxLength + 1) }));
    expect(longSubject.status).toBe(400);
    expect(longSubject.body.details.fields).toHaveProperty('subject');
    const longDescription = await me.post('/pqrs', pqrsBody({ description: 'a'.repeat(limits.descriptionMaxLength + 1) }));
    expect(longDescription.status).toBe(400);
    expect(longDescription.body.details.fields).toHaveProperty('description');
    const exact = await me.post('/pqrs', pqrsBody({ subject: 'a'.repeat(limits.subjectMaxLength), description: 'b'.repeat(limits.descriptionMaxLength) }));
    expect(exact.status).toBe(201);
  });

  it('follows the limits stored in settings', async () => {
    await ctx.prisma.setting.create({ data: { key: 'pqrs.subjectMaxLength', value: 10 } });
    const me = await studentCaller(ctx);
    expect((await me.get('/pqrs/limits')).body.subjectMaxLength).toBe(10);
    expect((await me.post('/pqrs', pqrsBody({ subject: 'a'.repeat(11) }))).status).toBe(400);
  });

  it('answers 422 PQRS_TYPE_UNAVAILABLE for a type that is unknown, inactive, deleted or of another list', async () => {
    const me = await studentCaller(ctx);
    const inactive = await createPqrsType(ctx.prisma, { status: 'INACTIVE' });
    const deleted = await createPqrsType(ctx.prisma, { deletedAt: new Date() });
    await ctx.prisma.dropdownList.create({ data: { key: 'OTHER_LIST', nameEs: 'Otra', nameEn: 'Other' } });
    const other = await ctx.prisma.dropdownItem.create({
      data: { listId: (await ctx.prisma.dropdownList.findUniqueOrThrow({ where: { key: 'OTHER_LIST' } })).id, labelEs: 'x', labelEn: 'x', sortOrder: 1 },
    });
    for (const typeId of [crypto.randomUUID(), inactive.id, deleted.id, other.id]) {
      const res = await me.post('/pqrs', pqrsBody({ typeId }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PQRS_TYPE_UNAVAILABLE');
    }
    expect(await ctx.prisma.pqrs.count()).toBe(0);
  });

  it('returns the same PQRS with 200 when the request key is repeated, and creates only one', async () => {
    const me = await studentCaller(ctx);
    const body = pqrsBody();
    const first = await me.post('/pqrs', body);
    const again = await me.post('/pqrs', body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await ctx.prisma.pqrs.count()).toBe(1);
  });

  it('files only one PQRS when the same request arrives twice at once', async () => {
    const me = await studentCaller(ctx);
    const body = pqrsBody();
    const results = await Promise.all([me.post('/pqrs', body), me.post('/pqrs', body)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 201]);
    expect(await ctx.prisma.pqrs.count()).toBe(1);
  });

  it('keeps the request key per author: another author with the same key files a different PQRS', async () => {
    const [a, b] = [await studentCaller(ctx), await teacherCaller(ctx)];
    const body = pqrsBody();
    const first = await a.post('/pqrs', body);
    const second = await b.post('/pqrs', body);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('answers the limits of the configuration', async () => {
    const me = await teacherCaller(ctx);
    expect((await me.get('/pqrs/limits')).body).toEqual({ subjectMaxLength: 120, descriptionMaxLength: 2000, responseMaxLength: 2000 });
  });
});
