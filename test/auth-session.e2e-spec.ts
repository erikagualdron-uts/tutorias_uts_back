import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const DAY = 86_400_000;

describe('persistent session and logout (US5)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const login = async (email: string) =>
    (
      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: TEST_PASSWORD })
    ).body;
  const refresh = (refreshToken: string) =>
    ctx.http().post('/api/v1/auth/refresh').send({ refreshToken });
  const me = (accessToken: string) =>
    ctx
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

  it('rotates the refresh token and returns a working access token', async () => {
    const user = await createUser(ctx.prisma);
    const first = await login(user.email);
    const res = await refresh(first.refreshToken);

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
    expect(res.body.user.id).toBe(user.id);
    expect((await me(res.body.accessToken)).status).toBe(200);
  });

  it('revokes the session when an already rotated token is presented again', async () => {
    const user = await createUser(ctx.prisma);
    const first = await login(user.email);
    const second = (await refresh(first.refreshToken)).body;

    const replay = await refresh(first.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('SESSION_REVOKED');
    // The legitimate holder of the newest token is cut off too.
    expect((await refresh(second.refreshToken)).body.code).toBe(
      'SESSION_REVOKED',
    );
    expect((await me(second.accessToken)).body.code).toBe('SESSION_REVOKED');
  });

  it('expires after 30 days without use and slides the window with every use', async () => {
    const user = await createUser(ctx.prisma);
    let tokens = await login(user.email);

    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(29 * DAY);
      const res = await refresh(tokens.refreshToken);
      expect(res.status).toBe(200);
      tokens = res.body;
    }

    ctx.clock.advance(31 * DAY);
    const expired = await refresh(tokens.refreshToken);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('SESSION_EXPIRED');
    expect((await me(tokens.accessToken)).body.code).toBe('SESSION_EXPIRED');
  });

  it('logout closes only the current device', async () => {
    const user = await createUser(ctx.prisma);
    const phone = await login(user.email);
    const tablet = await login(user.email);

    const out = await ctx
      .http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${phone.accessToken}`);
    expect(out.status).toBe(204);

    expect((await refresh(phone.refreshToken)).body.code).toBe(
      'SESSION_REVOKED',
    );
    expect((await me(phone.accessToken)).body.code).toBe('SESSION_REVOKED');
    expect((await me(tablet.accessToken)).status).toBe(200);
    expect((await refresh(tablet.refreshToken)).status).toBe(200);
  });

  it('rejects an unknown refresh token and a malformed body', async () => {
    expect((await refresh('not-a-real-token')).body.code).toBe(
      'SESSION_REVOKED',
    );
    expect(
      (await ctx.http().post('/api/v1/auth/refresh').send({})).body.code,
    ).toBe('VALIDATION_FAILED');
  });

  it('lets a user with a temporary password sign out', async () => {
    const teacher = await createUser(ctx.prisma, {
      role: 'TEACHER',
      mustChangePassword: true,
    });
    const { accessToken } = await login(teacher.email);
    const out = await ctx
      .http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(out.status).toBe(204);
  });
});
