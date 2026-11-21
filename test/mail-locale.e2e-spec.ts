import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailProcessor } from '../src/mail/mail.processor.js';
import type { MailJob } from '../src/mail/mail.service.js';
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
      const data = { code: '123456', expiresAt: new Date() };
      const es = renderMail(template, 'es', data);
      const en = renderMail(template, 'en', data);
      expect(es.subject).not.toBe(en.subject);
      expect(JSON.stringify(es.blocks)).toContain('123456');
      expect(JSON.stringify(en.blocks)).toContain('123456');
    },
  );

  // Spec 015: the account codes go out with the brand, the expiry and no trace in subject or logs.
  describe.each([
    ['register', 'verification', 24 * 60 * 60_000],
    ['forgot-password', 'reset', 60 * 60_000],
  ] as const)('the %s code email', (path, template, ttlMs) => {
    async function sendIt() {
      const user = await createUser(ctx.prisma);
      const before = Date.now();
      await post(path, path === 'register' ? { email: 'ana@uts.edu.co', password: 'Clave1234', firstName: 'Ana', lastName: 'Pérez', locale: 'es' } : { email: user.email });
      const to = path === 'register' ? 'ana@uts.edu.co' : user.email;
      const job = ctx.mailbox.lastTo(to)!;
      await ctx.app.get(MailProcessor).process({ data: job } as Job<MailJob>);
      return { job, before, mail: ctx.smtp.to(to)[0] };
    }

    it('carries the expiry of the code and arrives with the brand and the logo', async () => {
      const { job, before, mail } = await sendIt();
      expect(job.template).toBe(template);
      expect(new Date(job.expiresAt).getTime()).toBeGreaterThanOrEqual(before + ttlMs - 1000);
      expect(new Date(job.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + ttlMs + 1000);
      expect(mail.html).toContain(`>${job.code}</div>`);
      expect(mail.html).toContain('cid:uts-logo');
      expect(mail.text).toContain('Institución Universitaria Tecnológica de Santander – UTS');
    });

    it('keeps the code out of the subject and out of the logs', async () => {
      const { job, mail } = await sendIt();
      expect(mail.subject).not.toContain(job.code);
      expect(ctx.logs.lines.join('\n')).not.toContain(job.code);
    });
  });
});
