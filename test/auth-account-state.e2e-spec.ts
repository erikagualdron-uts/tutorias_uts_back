import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UsersService } from '../src/users/users.service.js';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('disabled and deleted accounts (US6)', () => {
  let ctx: TestContext;
  let users: UsersService;

  beforeAll(async () => {
    ctx = await createTestApp();
    users = ctx.app.get(UsersService);
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const post = (path: string, body: object) =>
    ctx.http().post(`/api/v1/auth/${path}`).send(body);
  const login = (email: string, password = TEST_PASSWORD) =>
    post('login', { email, password });
  const me = (accessToken: string) =>
    ctx
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

  it('refuses login for a disabled account and for a deleted one', async () => {
    const disabled = await createUser(ctx.prisma, { status: 'INACTIVE' });
    const deleted = await createUser(ctx.prisma, { deletedAt: new Date() });

    const a = await login(disabled.email);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('ACCOUNT_DISABLED');
    const b = await login(deleted.email);
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('does not reveal the account state without the right password', async () => {
    const disabled = await createUser(ctx.prisma, { status: 'INACTIVE' });
    expect((await login(disabled.email, 'Incorrecta1')).body.code).toBe(
      'INVALID_CREDENTIALS',
    );
  });

  it('drops an open session on the next request and rejects its refresh', async () => {
    const user = await createUser(ctx.prisma);
    const { body } = await login(user.email);
    expect((await me(body.accessToken)).status).toBe(200);

    await users.setStatus(user.id, 'INACTIVE');
    expect((await me(body.accessToken)).body.code).toBe('ACCOUNT_DISABLED');
    expect(
      (await post('refresh', { refreshToken: body.refreshToken })).body.code,
    ).toBe('ACCOUNT_DISABLED');
  });

  it('applies the same to a soft-deleted account, even if its sessions were not revoked', async () => {
    const user = await createUser(ctx.prisma);
    const { body } = await login(user.email);

    await ctx.prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date() },
    });
    expect((await me(body.accessToken)).body.code).toBe('ACCOUNT_UNAVAILABLE');
    expect(
      (await post('refresh', { refreshToken: body.refreshToken })).body.code,
    ).toBe('ACCOUNT_UNAVAILABLE');
  });

  it('gives access back on reactivation with the current password', async () => {
    const user = await createUser(ctx.prisma);
    await users.setStatus(user.id, 'INACTIVE');
    expect((await login(user.email)).status).toBe(403);

    await users.setStatus(user.id, 'ACTIVE');
    expect((await login(user.email)).status).toBe(200);
  });

  it('keeps the deleted email taken and the history in place', async () => {
    const user = await createUser(ctx.prisma, { email: 'ana@uts.edu.co' });
    await login(user.email);
    await users.softDelete(user.id);

    const register = await post('register', {
      email: user.email,
      password: TEST_PASSWORD,
      firstName: 'Ana',
      lastName: 'Pérez',
      locale: 'es',
    });
    expect(register.status).toBe(409);

    const stored = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(stored.deletedAt).not.toBeNull();
    const sessions = await ctx.prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].revokedAt).not.toBeNull();
  });
});
