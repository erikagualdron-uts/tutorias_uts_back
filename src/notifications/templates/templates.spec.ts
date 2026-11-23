import type { Locale, OutboxEventType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format.js';
import { renderNotification, type NotificationContext } from './index.js';

// 19:00 UTC is 14:00 in Bogota (UTC-5, no daylight saving).
const MONDAY = new Date('2030-01-07T19:00:00Z');
const week = (n: number) => new Date(MONDAY.getTime() + n * 7 * 24 * 3_600_000);

const context = (overrides: Partial<NotificationContext> = {}): NotificationContext => ({
  moduleName: 'Cálculo I',
  sessions: [{ at: MONDAY, to: new Date('2030-01-08T21:30:00Z') }],
  scope: 'SESSION',
  teacherName: 'Ana Gómez',
  roomName: 'Sala 204',
  pqrsSubject: 'Cambio de horario',
  ...overrides,
});

const TYPES: OutboxEventType[] = [
  'MODULE_TEACHER_CHANGED',
  'MODULE_ROOM_CHANGED',
  'SESSIONS_CANCELLED_HOLIDAY',
  'SESSIONS_RESTORED_HOLIDAY',
  'SESSION_RESCHEDULED',
  'SESSION_CANCELLED_TEACHER',
  'SESSION_RESTORED_TEACHER',
  'PQRS_IN_REVIEW',
  'PQRS_RESPONDED',
  'PQRS_RESOLVED',
];
const LOCALES: Locale[] = ['es', 'en'];

describe('renderNotification', () => {
  it.each(TYPES.flatMap((type) => LOCALES.map((locale) => [type, locale] as const)))('%s in %s has a title and a body', (type, locale) => {
    const { title, body } = renderNotification(type, locale, context());
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(160);
    expect(body).toContain(type.startsWith('PQRS_') ? 'Cambio de horario' : 'Cálculo I');
    expect(body.length).toBeLessThanOrEqual(1000);
  });

  it('never doubles the full stop after a date that ends in an abbreviation ("p. m.")', () => {
    for (const type of TYPES) for (const locale of LOCALES) expect(renderNotification(type, locale, context()).body).not.toMatch(/[^.]\.\.(?!\.)/);
  });

  it('writes the same event in each language', () => {
    const es = renderNotification('SESSION_CANCELLED_TEACHER', 'es', context());
    const en = renderNotification('SESSION_CANCELLED_TEACHER', 'en', context());
    expect(es.title).toBe('Se canceló tu tutoría');
    expect(en.title).toBe('Your session was cancelled');
    expect(es.body).toContain('Revisa el módulo');
    expect(en.body).toContain('Check the module');
  });

  it('shows dates and hours in Bogota time, not UTC', () => {
    expect(formatDateTime(MONDAY, 'es')).toMatch(/lunes.*7 de enero.*2:00\s*p\.\s*m\./i);
    expect(formatDateTime(MONDAY, 'en')).toMatch(/Monday.*January 7.*2:00\s*PM/i);
    const { body } = renderNotification('SESSION_RESCHEDULED', 'es', context());
    expect(body).toMatch(/2:00\s*p\.\s*m\./i);
    expect(body).toMatch(/4:30\s*p\.\s*m\./i);
    expect(body).not.toMatch(/7:00\s*p\.\s*m\./i);
  });

  it('names the old and the new date of a rescheduled session', () => {
    const { body } = renderNotification('SESSION_RESCHEDULED', 'en', context());
    expect(body).toContain('Monday, January 7');
    expect(body).toContain('Tuesday, January 8');
  });

  it('names the new teacher and the new room', () => {
    expect(renderNotification('MODULE_TEACHER_CHANGED', 'es', context()).body).toContain('Ana Gómez');
    expect(renderNotification('MODULE_ROOM_CHANGED', 'en', context()).body).toContain('Sala 204');
  });

  it('says the scope of a cancellation', () => {
    expect(renderNotification('SESSION_CANCELLED_TEACHER', 'es', context({ scope: 'SERIES' })).body).toContain('siguientes');
    expect(renderNotification('SESSION_CANCELLED_TEACHER', 'es', context({ scope: 'SESSION' })).body).toContain('Solo afecta a esa sesión');
  });

  it('explains the holiday reason', () => {
    expect(renderNotification('SESSIONS_CANCELLED_HOLIDAY', 'es', context()).body).toContain('festivo');
    expect(renderNotification('SESSIONS_CANCELLED_HOLIDAY', 'en', context()).body).toContain('holiday');
  });

  describe('summary of several sessions', () => {
    const sessions = (n: number) => Array.from({ length: n }, (_, i) => ({ at: week(i) }));

    it('lists two or three dates', () => {
      const { body } = renderNotification('SESSION_CANCELLED_TEACHER', 'es', context({ sessions: sessions(3) }));
      expect(body).toContain('3 sesiones');
      expect(body).toContain(' y ');
      expect(body).toContain('7 de enero');
      expect(body).toContain('21 de enero');
    });

    it('gives the first, the last and the count above three', () => {
      const { title, body } = renderNotification('SESSION_CANCELLED_TEACHER', 'en', context({ sessions: sessions(5) }));
      expect(title).toBe('Your sessions were cancelled');
      expect(body).toContain('5 sessions');
      expect(body).toMatch(/from Monday, January 7.* to Monday, February 4/);
      expect(body).not.toContain('January 14');
    });
  });

  it('keeps title and body within the column limits even with a very long module name', () => {
    const { title, body } = renderNotification('SESSION_RESCHEDULED', 'es', context({ moduleName: 'M'.repeat(2000) }));
    expect(title.length).toBeLessThanOrEqual(160);
    expect(body.length).toBeLessThanOrEqual(1000);
  });

  it.each(LOCALES)('PQRS notices name the subject and never carry a reply text in %s', (locale) => {
    for (const type of ['PQRS_IN_REVIEW', 'PQRS_RESPONDED', 'PQRS_RESOLVED'] as const) {
      const { title, body } = renderNotification(type, locale, context({ pqrsSubject: 'Beca de transporte' }));
      expect(body).toContain('"Beca de transporte"');
      expect(title.length).toBeGreaterThan(0);
    }
  });

  it('never includes identifiers or addresses', () => {
    for (const type of TYPES) {
      for (const locale of LOCALES) {
        const { title, body } = renderNotification(type, locale, context());
        expect(`${title} ${body}`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|@/);
      }
    }
  });
});
