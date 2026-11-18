import { describe, expect, it } from 'vitest';
import { AppException } from '../common/errors/app.exception.js';
import { parseCalendarRange, pickCalendarPeriod } from './calendar.rules.js';

describe('parseCalendarRange', () => {
  it('accepts a week and a single day', () => {
    expect(parseCalendarRange('2030-01-07', '2030-01-13').to.toISOString()).toBe('2030-01-13T00:00:00.000Z');
    expect(parseCalendarRange('2030-01-07', '2030-01-07').from.toISOString()).toBe('2030-01-07T00:00:00.000Z');
  });

  it('allows 7 days and rejects 8', () => {
    expect(() => parseCalendarRange('2030-01-07', '2030-01-13')).not.toThrow();
    expect(() => parseCalendarRange('2030-01-07', '2030-01-14')).toThrow(AppException);
  });

  it.each([
    [undefined, '2030-01-13'],
    ['2030-01-07', undefined],
    ['hoy', '2030-01-13'],
    ['2030-02-30', '2030-03-02'],
    ['2030-01-13', '2030-01-07'],
  ])('rejects %s to %s with VALIDATION_FAILED', (from, to) => {
    expect(() => parseCalendarRange(from, to)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('pickCalendarPeriod', () => {
  it('prefers the active period, then the last closed one, then none', () => {
    expect(pickCalendarPeriod('active', 'closed')).toBe('active');
    expect(pickCalendarPeriod(null, 'closed')).toBe('closed');
    expect(pickCalendarPeriod(null, null)).toBeNull();
  });
});
