import { describe, expect, it } from 'vitest';
import { bogotaCalendarDay, endOfDayInBogotaUtc } from './clock.js';

describe('Bogota calendar helpers', () => {
  it('ends the day at 05:00 UTC of the next day', () => {
    const end = endOfDayInBogotaUtc(new Date('2026-12-15T00:00:00Z'));
    expect(end.toISOString()).toBe('2026-12-16T05:00:00.000Z');
  });

  it('rolls over month and year', () => {
    expect(endOfDayInBogotaUtc(new Date('2026-12-31T00:00:00Z')).toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });

  it('maps an instant to its Bogota calendar day', () => {
    // 03:00 UTC is still the previous evening (22:00) in Bogota
    expect(bogotaCalendarDay(new Date('2026-12-16T03:00:00Z')).toISOString()).toBe('2026-12-15T00:00:00.000Z');
    expect(bogotaCalendarDay(new Date('2026-12-16T05:00:00Z')).toISOString()).toBe('2026-12-16T00:00:00.000Z');
  });
});
