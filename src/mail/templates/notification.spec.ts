import { describe, expect, it } from 'vitest';
import { smtpCause } from '../smtp-errors.js';
import { renderNotificationMail } from './index.js';

const notice = { title: 'Se canceló tu tutoría', body: 'Cálculo I: se canceló la sesión del martes.' };

describe('notification email', () => {
  it('uses the title as the subject and the text as the body, in Spanish', () => {
    const { subject, text } = renderNotificationMail('es', notice);
    expect(subject).toBe('Se canceló tu tutoría - UTS Tutorías');
    expect(text).toContain('Hola,');
    expect(text).toContain(notice.body);
  });

  it('greets in English for an English student', () => {
    const { text } = renderNotificationMail('en', { title: 'Your session was cancelled', body: 'Calculus: cancelled.' });
    expect(text.startsWith('Hello,')).toBe(true);
  });

  it('closes with the official name of the institution, in both languages', () => {
    for (const locale of ['es', 'en'] as const) {
      expect(renderNotificationMail(locale, notice).text).toContain('Institución Universitaria Tecnológica de Santander – UTS');
      expect(renderNotificationMail(locale, notice).text).not.toContain('Unidades Tecnológicas');
    }
  });

  it('is plain text with nothing about other students', () => {
    const { text } = renderNotificationMail('es', notice);
    expect(text).not.toMatch(/<[a-z]+/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe('smtpCause', () => {
  it.each([
    ['EAUTH', 'AUTH_FAILED'],
    ['ECONNECTION', 'CONNECTION_FAILED'],
    ['ENOTFOUND', 'CONNECTION_FAILED'],
    ['ETIMEDOUT', 'TIMEOUT'],
    ['EENVELOPE', 'SENDER_REJECTED'],
  ])('maps %s to %s', (code, cause) => {
    expect(smtpCause({ code })).toBe(cause);
  });

  it('answers UNKNOWN for anything else and never reads the message', () => {
    expect(smtpCause(new Error('auth failed for user@uts.edu.co'))).toBe('UNKNOWN');
    expect(smtpCause(undefined)).toBe('UNKNOWN');
    expect(smtpCause({ code: 42 })).toBe('UNKNOWN');
  });
});
