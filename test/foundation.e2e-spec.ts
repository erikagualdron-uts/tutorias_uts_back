import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from './utils/test-app.js';
import { PasswordService } from '../src/auth/password.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { createUser } from './utils/factories.js';

describe('foundation', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('answers errors with the standard format under the /api/v1 prefix', async () => {
    const res = await ctx.http().get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('creates a session and rotates its refresh token, revoking the session if the old one is reused', async () => {
    const user = await createUser(ctx.prisma);
    const sessions = ctx.app.get(SessionService);
    const { refreshToken } = await sessions.create(user.id);

    const rotated = await sessions.rotate(refreshToken);
    expect(rotated.refreshToken).not.toBe(refreshToken);

    await expect(sessions.rotate(refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
    await expect(sessions.rotate(rotated.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });

  it('expires a session after the inactivity window and renews the window on use', async () => {
    const user = await createUser(ctx.prisma);
    const sessions = ctx.app.get(SessionService);
    const { refreshToken } = await sessions.create(user.id);

    ctx.clock.advance(29 * 86_400_000);
    const { refreshToken: renewed } = await sessions.rotate(refreshToken);
    ctx.clock.advance(29 * 86_400_000);
    const { refreshToken: stillValid } = await sessions.rotate(renewed);
    ctx.clock.advance(31 * 86_400_000);
    await expect(sessions.rotate(stillValid)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it('enforces the password policy', async () => {
    const passwords = ctx.app.get(PasswordService);
    await expect(passwords.assertPolicy('short1')).rejects.toMatchObject({
      code: 'PASSWORD_TOO_WEAK',
    });
    await expect(passwords.assertPolicy('onlyletters')).rejects.toMatchObject({
      code: 'PASSWORD_TOO_WEAK',
    });
    await expect(passwords.assertPolicy('Clave1234')).resolves.toBeUndefined();
  });
});
