import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'a'.repeat(32),
  CODE_HMAC_SECRET: 'b',
  SMTP_ENCRYPTION_KEY: 'c'.repeat(64),
};

describe('email brand', () => {
  it('defaults to the official name with no contact and no footer', () => {
    const env = validateEnv(base);
    expect(env.MAIL_BRAND_NAME).toBe('Institución Universitaria Tecnológica de Santander – UTS');
    expect(env.MAIL_CONTACT_EMAIL).toBe('');
    expect(env.MAIL_FOOTER_TEXT).toBe('');
  });

  it('reads the values and ignores a blank name', () => {
    const env = validateEnv({ ...base, MAIL_BRAND_NAME: 'UTS', MAIL_CONTACT_EMAIL: ' cae@uts.edu.co ', MAIL_FOOTER_TEXT: 'Aviso' });
    expect([env.MAIL_BRAND_NAME, env.MAIL_CONTACT_EMAIL, env.MAIL_FOOTER_TEXT]).toEqual(['UTS', 'cae@uts.edu.co', 'Aviso']);
    expect(validateEnv({ ...base, MAIL_BRAND_NAME: '  ' }).MAIL_BRAND_NAME).toContain('Santander');
  });
});

describe('STUDENT_CANCEL_LEAD_MINUTES', () => {
  it('defaults to 60', () => {
    expect(validateEnv(base).STUDENT_CANCEL_LEAD_MINUTES).toBe(60);
  });

  it('accepts a positive integer', () => {
    expect(validateEnv({ ...base, STUDENT_CANCEL_LEAD_MINUTES: '90' }).STUDENT_CANCEL_LEAD_MINUTES).toBe(90);
  });

  it.each(['0', '-5', 'abc', '1.5'])('rejects %s', (value) => {
    expect(() => validateEnv({ ...base, STUDENT_CANCEL_LEAD_MINUTES: value })).toThrow(
      'STUDENT_CANCEL_LEAD_MINUTES must be a positive integer',
    );
  });
});

describe('TEACHER_CHANGE_LEAD_MINUTES', () => {
  it('defaults to 120', () => {
    expect(validateEnv(base).TEACHER_CHANGE_LEAD_MINUTES).toBe(120);
  });

  it('accepts a positive integer', () => {
    expect(validateEnv({ ...base, TEACHER_CHANGE_LEAD_MINUTES: '90' }).TEACHER_CHANGE_LEAD_MINUTES).toBe(90);
  });

  it.each(['0', '-5', 'abc', '1.5'])('rejects %s', (value) => {
    expect(() => validateEnv({ ...base, TEACHER_CHANGE_LEAD_MINUTES: value })).toThrow(
      'TEACHER_CHANGE_LEAD_MINUTES must be a positive integer',
    );
  });
});

describe.each([
  ['OUTBOX_POLL_SECONDS', 5],
  ['NOTIFICATION_DELIVERY_ATTEMPTS', 8],
  ['NOTIFICATION_BACKOFF_SECONDS', 15],
  ['NOTIFICATION_SWEEP_SECONDS', 60],
] as const)('%s', (key, fallback) => {
  it(`defaults to ${fallback}`, () => {
    expect(validateEnv(base)[key]).toBe(fallback);
  });

  it('accepts a positive integer', () => {
    expect(validateEnv({ ...base, [key]: '30' })[key]).toBe(30);
  });

  it.each(['0', '-5', 'abc', '1.5'])('rejects %s', (value) => {
    expect(() => validateEnv({ ...base, [key]: value })).toThrow(`${key} must be a positive integer`);
  });
});
