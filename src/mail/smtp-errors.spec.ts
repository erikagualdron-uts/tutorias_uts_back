import { describe, expect, it } from 'vitest';
import { smtpCause } from './smtp-errors.js';

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
