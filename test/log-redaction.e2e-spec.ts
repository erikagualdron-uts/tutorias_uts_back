import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createUser, TEST_PASSWORD } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('logs never contain secrets', () => {
  let ctx: TestContext;
  let output = '';

  beforeAll(async () => {
    ctx = await createTestApp();
    // Everything the process writes to stdout or stderr is collected, including Nest's logger.
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation(
        (chunk: string | Uint8Array) => {
          output += String(chunk);
          return true;
        },
      );
    }
  });
  beforeEach(() => ctx.reset());
  afterAll(async () => {
    vi.restoreAllMocks();
    await ctx.close();
  });

  const post = (path: string, body: object, token?: string) => {
    const req = ctx.http().post(`/api/v1${path}`);
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };

  it('keeps passwords, temporary passwords, codes and tokens out of the logs', async () => {
    const secrets: string[] = [];
    const student = {
      email: 'ana@uts.edu.co',
      password: 'SecretaReg123',
      firstName: 'Ana',
      lastName: 'Pérez',
      locale: 'es',
    };

    await post('/auth/register', student);
    const verification = ctx.mailbox.lastTo(student.email)!.code;
    await post('/auth/verify-email', {
      email: student.email,
      code: verification,
    });
    const login = await post('/auth/login', {
      email: student.email,
      password: student.password,
    });
    await post('/auth/login', {
      email: student.email,
      password: 'ClaveErrada999',
    });
    const refreshed = await post('/auth/refresh', {
      refreshToken: login.body.refreshToken,
    });
    await post(
      '/auth/change-password',
      { currentPassword: student.password, newPassword: 'NuevaSecreta456' },
      refreshed.body.accessToken,
    );

    await post('/auth/forgot-password', { email: student.email });
    const reset = ctx.mailbox.lastTo(student.email)!.code;
    await post('/auth/reset-password', {
      email: student.email,
      code: reset,
      newPassword: 'RecuperadaSecreta789',
    });
    await post('/auth/register', { ...student, password: 'x' }); // validation failure with a password in the body

    const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
    const adminLogin = await post('/auth/login', {
      email: admin.email,
      password: TEST_PASSWORD,
    });
    const teacher = await post(
      '/teachers',
      {
        email: 'profe@correo.uts.edu.co',
        firstName: 'Luis',
        lastName: 'Gómez',
      },
      adminLogin.body.accessToken,
    );

    secrets.push(
      student.password,
      'ClaveErrada999',
      'NuevaSecreta456',
      'RecuperadaSecreta789',
      verification,
      reset,
      login.body.accessToken,
      login.body.refreshToken,
      refreshed.body.accessToken,
      refreshed.body.refreshToken,
      adminLogin.body.accessToken,
      adminLogin.body.refreshToken,
      teacher.body.temporaryPassword,
    );
    expect(teacher.status).toBe(201);
    for (const secret of secrets) expect(secret).toBeTruthy();
    for (const secret of secrets)
      expect(output, `log leaked ${secret.slice(0, 4)}…`).not.toContain(secret);
  });
});
