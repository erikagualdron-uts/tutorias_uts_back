import type { Locale, OutboxEventType } from '@prisma/client';
import { en } from './en.js';
import { es } from './es.js';
import { clip } from './format.js';
import type { NotificationContext, Rendered, TemplateSet } from './types.js';

export type { NotificationContext, Rendered, SessionChange } from './types.js';

const SETS: Record<Locale, TemplateSet> = { es, en };

// The only place that writes the text of a notice (FR-006); the push and the email reuse it.
export function renderNotification(type: OutboxEventType, locale: Locale, context: NotificationContext): Rendered {
  const { title, body } = SETS[locale][type](context);
  // A date can end in "p. m." and the sentence adds its own full stop: one is enough.
  return { title: clip(title, 160), body: clip(body.replace(/([^.])\.\.(?!\.)/g, '$1.'), 1000) };
}
