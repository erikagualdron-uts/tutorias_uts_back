import type { Locale, OutboxEventType } from '@prisma/client';
import type { MailTemplateName } from '../mail.service.js';
import type { MailContent, Tone } from './layout.js';
import { noticeEn } from './notice.en.js';
import { noticeEs } from './notice.es.js';
import { resetEn } from './reset.en.js';
import { resetEs } from './reset.es.js';
import { smtpTestEn } from './smtp-test.en.js';
import { smtpTestEs } from './smtp-test.es.js';
import { verificationEn } from './verification.en.js';
import { verificationEs } from './verification.es.js';

export interface CodeMailData {
  code: string;
  expiresAt: Date;
}
export type MailTemplate = (data: CodeMailData) => MailContent;

export const MAIL_TEMPLATES: Record<MailTemplateName, Record<Locale, MailTemplate>> = {
  verification: { es: verificationEs, en: verificationEn },
  reset: { es: resetEs, en: resetEn },
};

export const renderMail = (template: MailTemplateName, locale: Locale, data: CodeMailData): MailContent =>
  MAIL_TEMPLATES[template][locale](data);

// The email of a notice (spec 015): each type of event has its own introduction and accent; the title
// and the text of the notice come already written, in the language of the student, by
// notifications/templates (the only place that writes them).
export interface NoticeFrame {
  intro: string;
  badge: string;
  tone: Tone;
}
export interface NoticeFrames {
  byType: Record<OutboxEventType, NoticeFrame>;
  // A type added later without a frame still reaches the student.
  generic: NoticeFrame;
}

const NOTICE_FRAMES: Record<Locale, NoticeFrames> = { es: noticeEs, en: noticeEn };

export function renderNoticeMail(
  type: OutboxEventType,
  locale: Locale,
  notice: { title: string; body: string },
): MailContent {
  const frames = NOTICE_FRAMES[locale];
  const { intro, badge, tone } = frames.byType[type] ?? frames.generic;
  return {
    subject: `${notice.title} - UTS Tutorías`,
    lang: locale,
    badge,
    title: notice.title,
    tone,
    blocks: [
      { kind: 'p', text: intro },
      { kind: 'detail', text: notice.body },
    ],
  };
}

// The test email of the settings screen (FR-028): short, in the language of the CAE who asks.
export const renderSmtpTestMail = (locale: Locale): MailContent => ({ es: smtpTestEs, en: smtpTestEn })[locale];
