import type { Locale } from '@prisma/client';

const TIME_ZONE = 'America/Bogota';
const TAGS: Record<Locale, string> = { es: 'es-CO', en: 'en-US' };

// Every date a user reads is shown in Bogota time, whatever the server clock or zone is.
export function formatDateTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(TAGS[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TIME_ZONE,
  }).format(date);
}

export interface Words {
  and: string;
  fromTo: (first: string, last: string) => string;
}

// One date as is; two or three joined ("a, b and c"); more than three as the first and the last.
export function formatRange(dates: readonly Date[], locale: Locale, words: Words): string {
  const texts = dates.map((date) => formatDateTime(date, locale));
  if (texts.length <= 1) return texts[0] ?? '';
  if (texts.length <= 3) return `${texts.slice(0, -1).join(', ')} ${words.and} ${texts[texts.length - 1]}`;
  return words.fromTo(texts[0], texts[texts.length - 1]);
}

// Hard limits of the notification columns (data-model.md): title 160, body 1000.
export const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
