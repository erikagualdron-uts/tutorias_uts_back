import { describe, expect, it } from 'vitest';
import { hasEmailDomain, normalizeEmail } from './email.util.js';

describe('email utils', () => {
  it('normalizes case and surrounding spaces', () => {
    expect(normalizeEmail('  Ana.Perez@UTS.edu.co ')).toBe(
      'ana.perez@uts.edu.co',
    );
  });

  it('accepts the exact domain regardless of case', () => {
    expect(hasEmailDomain('Ana@UTS.EDU.CO', 'uts.edu.co')).toBe(true);
  });

  it.each([
    'ana@correo.uts.edu.co',
    'ana@uts.edu.co.example.com',
    'ana@evil-uts.edu.co',
    'ana@gmail.com',
    '@uts.edu.co',
    'a@b@uts.edu.co',
    'uts.edu.co',
  ])('rejects %s for the student domain', (email) => {
    expect(hasEmailDomain(email, 'uts.edu.co')).toBe(false);
  });
});
