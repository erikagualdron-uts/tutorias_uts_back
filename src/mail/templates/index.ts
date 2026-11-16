import type { Locale } from '@prisma/client';
import type { MailTemplateName } from '../mail.service.js';

export interface RenderedMail {
  subject: string;
  text: string;
}

export type MailTemplate = (code: string) => RenderedMail;

// Each story registers its templates here (verification.{es,en}.ts, reset.{es,en}.ts).
export const MAIL_TEMPLATES: Partial<
  Record<MailTemplateName, Record<Locale, MailTemplate>>
> = {};

export function renderMail(
  template: MailTemplateName,
  locale: Locale,
  code: string,
): RenderedMail {
  const byLocale = MAIL_TEMPLATES[template];
  if (!byLocale) throw new Error(`Mail template not registered: ${template}`);
  return byLocale[locale](code);
}
