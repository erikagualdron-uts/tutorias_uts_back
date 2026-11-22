import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { readBrand } from './brand.js';
import { composeMail, LOGO_CID, type MailContent } from './templates/layout.js';

// The one place that turns an email into what Nodemailer sends (FR-011): every path that sends mail
// goes through it, so the layout, the plain text and the inline logo are the same everywhere.
@Injectable()
export class MessageBuilder {
  // Read once; the file is the brand logo copied unchanged from the app (D-101).
  private readonly logo = readFileSync(join(process.cwd(), 'assets/brand/logo-uts.png'));

  constructor(private readonly config: ConfigService<Env, true>) {}

  build(from: string, to: string, content: MailContent) {
    const { subject, text, html } = composeMail(content, readBrand(this.config));
    return {
      from,
      to,
      subject,
      text,
      html,
      attachments: [{ filename: 'logo-uts.png', cid: LOGO_CID, content: this.logo, contentType: 'image/png' }],
    };
  }
}
