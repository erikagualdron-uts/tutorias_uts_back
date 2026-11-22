import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

export interface MailBrand {
  name: string;
  contactEmail: string;
  footerText: string;
}

export const readBrand = (config: ConfigService<Env, true>): MailBrand => ({
  name: config.get('MAIL_BRAND_NAME'),
  contactEmail: config.get('MAIL_CONTACT_EMAIL'),
  footerText: config.get('MAIL_FOOTER_TEXT'),
});
