import { describe, expect, it } from 'vitest';
import { endsAfterStart, formatCalendarDay, hasEnded, parseCalendarDay } from './periods.rules.js';

describe('period date rules', () => {
  it('accepts real calendar days only', () => {
    expect(parseCalendarDay('2026-12-15')?.toISOString()).toBe('2026-12-15T00:00:00.000Z');
    expect(parseCalendarDay('2026-02-30')).toBeNull();
    expect(parseCalendarDay('2026-13-01')).toBeNull();
    expect(parseCalendarDay('15/12/2026')).toBeNull();
  });

  it('formats back to YYYY-MM-DD', () => {
    expect(formatCalendarDay(new Date('2026-12-15T00:00:00Z'))).toBe('2026-12-15');
  });

  it('requires the end to be strictly after the start', () => {
    const day = new Date('2026-06-01T00:00:00Z');
    expect(endsAfterStart(day, day)).toBe(false);
    expect(endsAfterStart(day, new Date('2026-05-31T00:00:00Z'))).toBe(false);
    expect(endsAfterStart(day, new Date('2026-06-02T00:00:00Z'))).toBe(true);
  });

  it('keeps a period open until its last day ends in Bogota', () => {
    const endsOn = new Date('2026-12-15T00:00:00Z');
    expect(hasEnded(endsOn, new Date('2026-12-16T04:59:59Z'))).toBe(false);
    expect(hasEnded(endsOn, new Date('2026-12-16T05:00:00Z'))).toBe(true);
  });
});
