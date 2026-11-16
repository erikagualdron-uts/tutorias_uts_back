import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderMail } from '../src/mail/templates/index.js';
import { createUser } from './utils/factories.js';
import { createTestApp, type TestContext } from './utils/test-app.js';

describe('email language follows the stored locale (US7)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  const post = (path: string, body: object) =>
    ctx.http().post(`/api/v1/auth/${path}`).send(body);

  it.each(['es', 'en'] as const)(
    'queues the verification email in %s for a new student',
    async (locale) => {
      await post('register', {
        email: 'ana@uts.edu.co',
        password: 'Clave1234',
        firstName: 'Ana',
        lastName: 'Pérez',
        locale,
      });
      expect(ctx.mailbox.lastTo('ana@uts.edu.co')).toMatchObject({
        template: 'verification',
        locale,
      });
    },
  );

  it.each(['es', 'en'] as const)(
    'queues the recovery email in %s using the saved locale',
    async (locale) => {
      const user = await createUser(ctx.prisma);
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { locale },
      });
      await post('forgot-password', { email: user.email });
      expect(ctx.mailbox.lastTo(user.email)).toMatchObject({
        template: 'reset',
        locale,
      });
    },
  );

  it.each(['verification', 'reset'] as const)(
    'renders the %s template in Spanish and in English',
    (template) => {
      const es = renderMail(template, 'es', '123456');
      const en = renderMail(template, 'en', '123456');
      expect(es.subject).not.toBe(en.subject);
      expect(es.text).toContain('123456');
      expect(en.text).toContain('123456');
    },
  );
});
