import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { loadContract, specPath } from './utils/contract.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

const contract = loadContract(specPath('014-notifications/contracts/notifications-api.yaml'));
const METHODS = ['get', 'post', 'patch', 'put', 'delete'];
const ROLES = ['STUDENT', 'TEACHER', 'SUPERADMIN'] as const;
const UUID = '00000000-0000-4000-8000-000000000000';
const TOKEN = encodeURIComponent('ExponentPushToken[abc]');

// The inbox and the devices belong to any signed-in role (FR-025); the SMTP settings only to the CAE
// (added with story 6). The endpoint list comes from the contract, so a new one cannot skip the check.
describe.skipIf(!contract.available)('notifications: access by role', () => {
  let ctx: TestContext;
  const inboxEndpoints = Object.entries(contract.paths)
    .filter(([path]) => path.startsWith('/notifications'))
    .flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => METHODS.includes(method))
        .map((method) => ({ method, url: path.replace('{id}', UUID).replace('{token}', TOKEN) })),
    );

  beforeAll(async () => {
    ctx = await createTestApp();
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  const tokenOf = async (role: (typeof ROLES)[number]) => {
    const user = await createUser(ctx.prisma, { role });
    const res = await ctx.http().post('/api/v1/auth/login').send({ email: user.email, password: TEST_PASSWORD });
    return res.body.accessToken as string;
  };
  const call = (method: string, url: string, token?: string) => {
    const req = ctx.http()[method as 'get'](`/api/v1${url}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('covers every inbox and device endpoint of the contract', () => {
    expect(inboxEndpoints.length).toBe(6);
  });

  it('answers 401 without a token on every endpoint', async () => {
    for (const { method, url } of inboxEndpoints) {
      const res = await call(method, url);
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it.each(ROLES)('lets a %s see its own inbox and counter', async (role) => {
    const token = await tokenOf(role);
    expect((await call('get', '/notifications', token)).status).toBe(200);
    const count = await call('get', '/notifications/unread-count', token);
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ unread: 0 });
    expect((await call('post', '/notifications/read-all', token)).status).toBe(200);
  });

  it.each(ROLES)('lets a %s register and discard a device', async (role) => {
    const token = await tokenOf(role);
    const put = await call('put', '/notifications/devices', token).send({ token: 'ExponentPushToken[role-test]', platform: 'ANDROID' });
    expect(put.status).toBe(204);
    expect((await call('delete', `/notifications/devices/${encodeURIComponent('ExponentPushToken[role-test]')}`, token)).status).toBe(204);
  });

  describe('mail server settings (CAE only, FR-029)', () => {
    const smtpEndpoints = Object.entries(contract.paths)
      .filter(([path]) => path.startsWith('/settings/smtp'))
      .flatMap(([path, operations]) =>
        Object.keys(operations)
          .filter((method) => METHODS.includes(method))
          .map((method) => ({ method, url: path })),
      );
    const body = { host: 'smtp.uts.edu.co', port: 587, user: 'cae', password: 'clave', from: 'cae@uts.edu.co' };

    it('covers every settings endpoint of the contract', () => {
      expect(smtpEndpoints).toHaveLength(3);
    });

    it('answers 401 without a token on every endpoint', async () => {
      for (const { method, url } of smtpEndpoints) {
        const res = await call(method, url);
        expect(res.status, `${method} ${url}`).toBe(401);
      }
    });

    it.each(['STUDENT', 'TEACHER'] as const)('answers 403 to a %s on every endpoint (scenario 7)', async (role) => {
      const token = await tokenOf(role);
      for (const { method, url } of smtpEndpoints) {
        const res = await call(method, url, token).send(body);
        expect(res.status, `${method} ${url}`).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN_ROLE');
      }
    });

    it('lets the CAE read the settings', async () => {
      const token = await tokenOf('SUPERADMIN');
      expect((await call('get', '/settings/smtp', token)).status).toBe(200);
    });
  });
});
