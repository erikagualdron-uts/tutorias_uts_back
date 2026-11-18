import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'a'.repeat(32),
  CODE_HMAC_SECRET: 'b',
  SMTP_ENCRYPTION_KEY: 'c'.repeat(64),
};

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
