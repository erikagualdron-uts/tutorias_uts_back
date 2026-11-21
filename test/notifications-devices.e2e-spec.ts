import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginStudent, type Student } from './utils/enrollment.js';
import { TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';

// Registering the device for push (FR-014) and dropping it (FR-016).
describe('notifications: devices', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const register = (student: Student, body: object) =>
    ctx.http().put('/api/v1/notifications/devices').set('Authorization', `Bearer ${student.token}`).send(body);
  const discard = (student: Student, token: string) =>
    ctx.http().delete(`/api/v1/notifications/devices/${encodeURIComponent(token)}`).set('Authorization', `Bearer ${student.token}`);
  const rows = () => ctx.prisma.pushToken.findMany({ orderBy: { createdAt: 'asc' } });
  const live = () => ctx.prisma.pushToken.findMany({ where: { deletedAt: null } });

  it('registers a device for the user and the session of the token', async () => {
    const student = await loginStudent(ctx);
    await register(student, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    const [device] = await rows();
    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: student.user.id } });
    expect(device).toMatchObject({ userId: student.user.id, sessionId: session.id, token: TOKEN_A, platform: 'ANDROID', deletedAt: null });
  });

  it('is idempotent: the same token never creates a second row (FR-014)', async () => {
    const student = await loginStudent(ctx);
    await register(student, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    await register(student, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    expect(await rows()).toHaveLength(1);
  });

  it('lets one user have several devices (story 3, scenario 4)', async () => {
    const student = await loginStudent(ctx);
    await register(student, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    await register(student, { token: TOKEN_B, platform: 'IOS' }).expect(204);
    expect(await live()).toHaveLength(2);
  });

  it('moves a device to the user who registers it now: one device, one user', async () => {
    const first = await loginStudent(ctx);
    const second = await loginStudent(ctx);
    await register(first, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    await register(second, { token: TOKEN_A, platform: 'IOS' }).expect(204);
    const devices = await rows();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ userId: second.user.id, platform: 'IOS' });
  });

  it('brings a discarded device back when it is registered again', async () => {
    const student = await loginStudent(ctx);
    await register(student, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    await discard(student, TOKEN_A).expect(204);
    expect(await live()).toHaveLength(0);
    await register(student, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    expect(await live()).toHaveLength(1);
  });

  it.each([
    ['a token without the Expo format', { token: 'not-a-token', platform: 'ANDROID' }],
    ['a token that is too long', { token: `ExponentPushToken[${'x'.repeat(200)}]`, platform: 'ANDROID' }],
    ['an unknown platform', { token: TOKEN_A, platform: 'WINDOWS' }],
    ['a missing platform', { token: TOKEN_A }],
    ['an empty body', {}],
  ])('rejects %s', async (_label, body) => {
    const student = await loginStudent(ctx);
    await register(student, body).expect(400);
    expect(await rows()).toHaveLength(0);
  });

  it('discards only the device of the user, and answers 204 either way', async () => {
    const owner = await loginStudent(ctx);
    const other = await loginStudent(ctx);
    await register(owner, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    await discard(other, TOKEN_A).expect(204);
    expect(await live()).toHaveLength(1);
    await discard(owner, TOKEN_A).expect(204);
    expect(await live()).toHaveLength(0);
    await discard(owner, TOKEN_A).expect(204);
    await discard(owner, 'ExponentPushToken[unknown]').expect(204);
  });

  it('drops the devices of a session when the user signs out of it (story 3, scenario 5)', async () => {
    const student = await loginStudent(ctx);
    await register(student, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    await ctx.http().post('/api/v1/auth/logout').set('Authorization', `Bearer ${student.token}`).expect(204);
    expect(await live()).toHaveLength(0);
    expect((await rows())[0].deletedAt).not.toBeNull();
  });

  it('keeps the devices of the other sessions of the same user when one signs out', async () => {
    const phone = await loginStudent(ctx);
    const login = await ctx.http().post('/api/v1/auth/login').send({ email: phone.user.email, password: TEST_PASSWORD });
    const tablet = { ...phone, token: login.body.accessToken as string };
    await register(phone, { token: TOKEN_A, platform: 'ANDROID' }).expect(204);
    await register(tablet, { token: TOKEN_B, platform: 'IOS' }).expect(204);

    await ctx.http().post('/api/v1/auth/logout').set('Authorization', `Bearer ${phone.token}`).expect(204);

    expect((await live()).map((d) => d.token)).toEqual([TOKEN_B]);
  });

  it('answers 401 without a session', async () => {
    await ctx.http().put('/api/v1/notifications/devices').send({ token: TOKEN_A, platform: 'ANDROID' }).expect(401);
  });
});
