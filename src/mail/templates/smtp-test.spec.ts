import { describe, expect, it } from 'vitest';
import type { MailBrand } from '../brand.js';
import { renderSmtpTestMail } from './index.js';
import { composeMail } from './layout.js';

const brand: MailBrand = { name: 'Institución Universitaria Tecnológica de Santander – UTS', contactEmail: '', footerText: '' };

describe('smtp test email', () => {
  it.each([
    ['es', 'Prueba de correo - UTS Tutorías', 'El servidor de correo de UTS Tutorías funciona'],
    ['en', 'Email test - UTS Tutorías', 'The mail server of UTS Tutorías is working'],
  ] as const)('is short, branded and says it can be ignored in %s', (locale, subject, sentence) => {
    const mail = composeMail(renderSmtpTestMail(locale), brand);
    expect(mail.subject).toBe(subject);
    for (const part of [mail.html, mail.text]) {
      expect(part).toContain(sentence);
      expect(part).toContain(brand.name);
    }
    expect(mail.text).not.toMatch(/undefined|\{\{/);
  });
});
