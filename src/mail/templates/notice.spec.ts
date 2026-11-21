import { OutboxEventType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { MailBrand } from '../brand.js';
import { renderNoticeMail } from './index.js';
import { composeMail, type Tone } from './layout.js';

const brand: MailBrand = { name: 'Institución Universitaria Tecnológica de Santander – UTS', contactEmail: '', footerText: '' };
const TYPES = Object.values(OutboxEventType);
const LOCALES = ['es', 'en'] as const;
const notice = { title: 'Se reprogramó tu tutoría', body: 'Cálculo I: pasó del martes al miércoles. Revisa el módulo en la app.' };
const compose = (type: OutboxEventType, locale: 'es' | 'en', n = notice) => composeMail(renderNoticeMail(type, locale, n), brand);

describe('notice email', () => {
  it.each(LOCALES)('has its own introduction for each of the seven types in %s', (locale) => {
    const intros = TYPES.map((type) => renderNoticeMail(type, locale, notice).blocks[0].text);
    expect(TYPES).toHaveLength(7);
    expect(new Set(intros).size).toBe(7);
  });

  it.each(TYPES.flatMap((type) => LOCALES.map((locale) => [type, locale] as const)))('%s in %s carries the notice, the brand and nothing unresolved', (type, locale) => {
    const { subject, html, text } = compose(type, locale);
    expect(subject).toBe(`${notice.title} - UTS Tutorías`);
    for (const part of [notice.title, notice.body]) {
      expect(html).toContain(part);
      expect(text).toContain(part);
    }
    for (const out of [subject, html, text]) expect(out).not.toMatch(/undefined|\{\{|\$\{/);
    expect(text).toContain(brand.name);
    expect(text).not.toContain('Unidades Tecnológicas');
  });

  it('escapes what a user wrote in the html and leaves it literal in the text', () => {
    const { html, text } = compose('SESSION_RESCHEDULED', 'es', { title: '<b>x</b> & y', body: 'Módulo <i>A</i>' });
    expect(html).not.toMatch(/<b>x|<i>A/);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(text).toContain('<b>x</b> & y');
  });

  it('keeps the frame whole with a 1000 character body and puts each line in its own paragraph', () => {
    const long = compose('MODULE_ROOM_CHANGED', 'en', { title: 'Room changed', body: `${'x'.repeat(1000)}\nSecond line` });
    expect(long.html).toContain('</html>');
    expect(long.html).toContain('Second line</p>');
  });

  it('falls back to the general frame for a type without its own', () => {
    const content = renderNoticeMail('SOMETHING_NEW' as OutboxEventType, 'es', notice);
    expect(content.tone).toBe('info');
    expect(content.blocks[0].text).toContain('Hola');
  });

  it('picks the accent by type: errors for cancellations, warning for the move, success for restores, info for the rest', () => {
    const tones: Record<OutboxEventType, Tone> = {
      SESSION_CANCELLED_TEACHER: 'error',
      SESSIONS_CANCELLED_HOLIDAY: 'error',
      SESSION_RESCHEDULED: 'warning',
      SESSION_RESTORED_TEACHER: 'success',
      SESSIONS_RESTORED_HOLIDAY: 'success',
      MODULE_TEACHER_CHANGED: 'info',
      MODULE_ROOM_CHANGED: 'info',
    };
    for (const type of TYPES) expect(renderNoticeMail(type, 'es', notice).tone).toBe(tones[type]);
  });
});
