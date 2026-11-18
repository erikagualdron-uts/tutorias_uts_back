import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertDocumented,
  assertMatchesSchema,
  contractAvailable,
} from './utils/contract.js';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe.skipIf(!contractAvailable)(
  'responses match specs/001-auth-roles/contracts/auth-api.yaml',
  () => {
    let ctx: TestContext;

    beforeAll(async () => {
      ctx = await createTestApp();
    });
    beforeEach(() => ctx.reset());
    afterAll(() => ctx.close());

    // Calls the API under /api/v1 and checks status and body against the contract.
    async function call(
      method: 'get' | 'post',
      path: string,
      {
        body,
        token,
        schema,
        errorSchema = 'Error',
      }: {
        body?: object;
        token?: string;
        schema?: string;
        errorSchema?: string;
      } = {},
    ) {
      let req = ctx.http()[method](`/api/v1${path}`);
      if (token) req = req.set('Authorization', `Bearer ${token}`);
      const res = await (body ? req.send(body) : req);
      assertDocumented(method, path, res.status);
      if (res.status >= 400) assertMatchesSchema(errorSchema, res.body);
      else if (schema) assertMatchesSchema(schema, res.body);
      return res;
    }

    const student = {
      email: 'ana@uts.edu.co',
      password: TEST_PASSWORD,
      firstName: 'Ana',
      lastName: 'Pérez',
      locale: 'es',
    };

    it('registration, verification and resend', async () => {
      await call('post', '/auth/register', {
        body: student,
        schema: 'CodeSent',
      });
      await call('post', '/auth/register', {
        body: { ...student, email: 'ana@gmail.com' },
      });
      await call('post', '/auth/register', {
        body: { ...student, locale: 'fr' },
      });
      await call('post', '/auth/resend-verification', {
        body: { email: student.email },
        schema: 'CodeSent',
      });
      await call('post', '/auth/verify-email', {
        body: { email: student.email, code: '000000' },
      });

      const { code } = ctx.mailbox.lastTo(student.email)!;
      await call('post', '/auth/verify-email', {
        body: { email: student.email, code },
      });
      await call('post', '/auth/register', { body: student });
    });

    it('login, me, refresh and logout', async () => {
      const user = await createUser(ctx.prisma);
      await call('post', '/auth/login', {
        body: { email: user.email, password: 'Incorrecta1' },
      });
      const login = await call('post', '/auth/login', {
        body: { email: user.email, password: TEST_PASSWORD },
        schema: 'AuthTokens',
      });

      await call('get', '/auth/me', {
        token: login.body.accessToken,
        schema: 'UserSummary',
      });
      await call('get', '/auth/me');
      const refreshed = await call('post', '/auth/refresh', {
        body: { refreshToken: login.body.refreshToken },
        schema: 'AuthTokens',
      });
      await call('post', '/auth/logout', { token: refreshed.body.accessToken });
      await call('post', '/auth/refresh', {
        body: { refreshToken: login.body.refreshToken },
      });
    });

    it('login errors for unverified, disabled and rate-limited accounts', async () => {
      const unverified = await createUser(ctx.prisma, { verified: false });
      await call('post', '/auth/login', {
        body: { email: unverified.email, password: TEST_PASSWORD },
      });
      const disabled = await createUser(ctx.prisma, { status: 'INACTIVE' });
      await call('post', '/auth/login', {
        body: { email: disabled.email, password: TEST_PASSWORD },
      });

      const target = await createUser(ctx.prisma);
      for (let i = 0; i < 6; i++)
        await call('post', '/auth/login', {
          body: { email: target.email, password: 'Incorrecta1' },
        });
    });

    it('password recovery and change', async () => {
      const user = await createUser(ctx.prisma);
      await call('post', '/auth/forgot-password', {
        body: { email: user.email },
        schema: 'CodeSent',
      });
      const { code } = ctx.mailbox.lastTo(user.email)!;
      await call('post', '/auth/reset-password', {
        body: { email: user.email, code: '000000', newPassword: 'Nueva12345' },
      });
      await call('post', '/auth/reset-password', {
        body: { email: user.email, code, newPassword: 'Nueva12345' },
      });

      const { body } = await call('post', '/auth/login', {
        body: { email: user.email, password: 'Nueva12345' },
        schema: 'AuthTokens',
      });
      await call('post', '/auth/change-password', {
        token: body.accessToken,
        body: { currentPassword: 'Otra1234x', newPassword: 'Tercera123' },
      });
      await call('post', '/auth/change-password', {
        token: body.accessToken,
        body: { currentPassword: 'Nueva12345', newPassword: 'corta1' },
      });
      await call('post', '/auth/change-password', {
        token: body.accessToken,
        body: { currentPassword: 'Nueva12345', newPassword: 'Tercera123' },
      });
    });

    it('teacher creation', async () => {
      const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
      const student = await createUser(ctx.prisma);
      const login = async (email: string) =>
        (
          await ctx
            .http()
            .post('/api/v1/auth/login')
            .send({ email, password: TEST_PASSWORD })
        ).body.accessToken as string;
      const body = {
        email: 'profe@correo.uts.edu.co',
        firstName: 'Luis',
        lastName: 'Gómez',
      };

      await call('post', '/teachers', {
        token: await login(student.email),
        body,
      });
      const adminToken = await login(admin.email);
      const created = await call('post', '/teachers', {
        token: adminToken,
        body,
        schema: 'CreateTeacherResponse',
      });
      expect(created.body.temporaryPassword).toBeTruthy();
      await call('post', '/teachers', { token: adminToken, body });
      await call('post', '/teachers', {
        token: adminToken,
        body: { ...body, email: 'otro@uts.edu.co' },
      });
    });
  },
);
