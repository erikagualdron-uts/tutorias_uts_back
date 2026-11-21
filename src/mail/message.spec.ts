import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { MessageBuilder } from './message.js';
import { LOGO_CID, type MailContent } from './templates/layout.js';

const config = {
  get: (key: string) =>
    ({ MAIL_BRAND_NAME: 'UTS', MAIL_CONTACT_EMAIL: '', MAIL_FOOTER_TEXT: '' })[key],
} as unknown as ConfigService<Env, true>;
const content: MailContent = { subject: 'Hola', title: 'Hola', tone: 'info', blocks: [{ kind: 'p', text: 'Texto' }] };

describe('MessageBuilder', () => {
  const message = new MessageBuilder(config).build('no-reply@uts.edu.co', 'ana@uts.edu.co', content);

  it('builds the envelope with the subject, the text and the html', () => {
    expect(message).toMatchObject({ from: 'no-reply@uts.edu.co', to: 'ana@uts.edu.co', subject: 'Hola' });
    expect(message.text).toContain('Texto');
    expect(message.html).toContain('Texto');
  });

  it('attaches the logo unchanged under the cid the html uses', () => {
    const [logo] = message.attachments;
    expect(logo.cid).toBe(LOGO_CID);
    expect(message.html).toContain(`cid:${logo.cid}`);
    expect(Buffer.compare(logo.content, readFileSync(join(process.cwd(), 'assets/brand/logo-uts.png')))).toBe(0);
  });
});
