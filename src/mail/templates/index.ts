import type { Locale } from '@prisma/client';
import type { MailTemplateName } from '../mail.service.js';
import { notificationEn } from './notification.en.js';
import { notificationEs } from './notification.es.js';
import { resetEn } from './reset.en.js';
import { resetEs } from './reset.es.js';
import { verificationEn } from './verification.en.js';
import { verificationEs } from './verification.es.js';

export interface RenderedMail {
  subject: string;
  text: string;
}

export type MailTemplate = (code: string) => RenderedMail;

// Each story registers its templates here (verification.{es,en}.ts, reset.{es,en}.ts).
export const MAIL_TEMPLATES: Partial<
  Record<MailTemplateName, Record<Locale, MailTemplate>>
> = {
  verification: { es: verificationEs, en: verificationEn },
  reset: { es: resetEs, en: resetEn },
};

export function renderMail(
  template: MailTemplateName,
  locale: Locale,
  code: string,
): RenderedMail {
  const byLocale = MAIL_TEMPLATES[template];
  if (!byLocale) throw new Error(`Mail template not registered: ${template}`);
  return byLocale[locale](code);
}

// The email of a notice (spec 014): the title and the text of the notice, already in the language of
// the student, with a greeting and the institution as the footer. Plain text, like the other emails.
export type NotificationMailTemplate = (notice: { title: string; body: string }) => RenderedMail;

const NOTIFICATION_MAIL: Record<Locale, NotificationMailTemplate> = {
  es: notificationEs,
  en: notificationEn,
};

export const renderNotificationMail = (
  locale: Locale,
  notice: { title: string; body: string },
): RenderedMail => NOTIFICATION_MAIL[locale](notice);

// The test email of the settings screen (FR-028): short, in the language of the CAE who asks.
export const renderSmtpTestMail = (locale: Locale): RenderedMail =>
  locale === 'en'
    ? {
        subject: 'Email test - UTS Tutorías',
        text: 'The mail server of UTS Tutorías is working. You can ignore this message.',
      }
    : {
        subject: 'Prueba de correo - UTS Tutorías',
        text: 'El servidor de correo de UTS Tutorías funciona. Puedes ignorar este mensaje.',
      };
