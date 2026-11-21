import { describe, expect, it } from 'vitest';
import type { MailBrand } from '../brand.js';
import { renderMail } from './index.js';
import { composeMail } from './layout.js';

const brand: MailBrand = { name: 'Institución Universitaria Tecnológica de Santander – UTS', contactEmail: '', footerText: '' };
// 20:42 UTC is 3:42 p. m. in Bogota (UTC-5 all year).
const data = { code: '123456', expiresAt: new Date('2026-11-21T20:42:00Z') };
const compose = (template: 'verification' | 'reset', locale: 'es' | 'en') => composeMail(renderMail(template, locale, data), brand);

describe.each(['verification', 'reset'] as const)('%s email', (template) => {
  it.each(['es', 'en'] as const)('shows the code highlighted, the expiry in Bogota time and the brand in %s', (locale) => {
    const { subject, html, text } = compose(template, locale);
    expect(html).toContain('>123456</div>');
    expect(text.split('\n')).toContain('123456');
    expect(text).toMatch(/3:42/);
    expect(text).toContain(brand.name);
    expect(subject).not.toContain('123456');
  });

  it('is different in Spanish and in English', () => {
    expect(compose(template, 'es').subject).not.toBe(compose(template, 'en').subject);
  });
});

describe('what each email tells you to do', () => {
  it('verification says to ignore it if you did not create the account', () => {
    expect(compose('verification', 'es').text).toContain('no creaste una cuenta');
    expect(compose('verification', 'en').text).toContain('did not create an account');
  });

  it('reset warns that nobody at UTS asks for the password', () => {
    expect(compose('reset', 'es').text).toContain('Nadie de la UTS te pedirá tu contraseña');
    expect(compose('reset', 'en').text).toContain('Nobody at UTS will ask you for your password');
  });
});
