import { describe, expect, it } from 'vitest';
import {
  bogotaToUtc,
  findOverlappingSlots,
  formatTime,
  isoWeekday,
  occurrences,
  parseTime,
  rangesOverlap,
  validateSlot,
} from './sessions.rules.js';

const day = (value: string) => new Date(`${value}T00:00:00Z`);
const TUESDAY = 2;
const THURSDAY = 4;
const afternoon = { startMinute: 14 * 60, endMinute: 16 * 60 };

describe('time of day', () => {
  it('parses HH:mm into minutes from midnight', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('14:30')).toBe(870);
    expect(parseTime('23:59')).toBe(1439);
  });

  it('rejects anything that is not a real time before 24:00', () => {
    for (const bad of ['24:00', '12:60', '7:00', '14:5', '1400', '', 'ab:cd', '14:00:00']) {
      expect(parseTime(bad)).toBeNull();
    }
  });

  it('formats minutes back to HH:mm', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(870)).toBe('14:30');
    expect(formatTime(1439)).toBe('23:59');
  });
});

describe('ranges overlap with a half-open [start, end)', () => {
  it('does not overlap when one ends exactly when the other starts', () => {
    expect(rangesOverlap(840, 960, 960, 1080)).toBe(false);
    expect(rangesOverlap(960, 1080, 840, 960)).toBe(false);
  });

  it('overlaps partially and totally', () => {
    expect(rangesOverlap(840, 960, 900, 1020)).toBe(true);
    expect(rangesOverlap(840, 960, 850, 900)).toBe(true);
    expect(rangesOverlap(840, 960, 840, 960)).toBe(true);
  });

  it('does not overlap when apart', () => {
    expect(rangesOverlap(840, 960, 1000, 1100)).toBe(false);
  });
});

describe('slot validation', () => {
  it('accepts a valid slot', () => {
    expect(validateSlot({ dayOfWeek: TUESDAY, ...afternoon })).toBe(true);
  });

  it('rejects an end that is not after the start', () => {
    expect(validateSlot({ dayOfWeek: TUESDAY, startMinute: 960, endMinute: 960 })).toBe(false);
    expect(validateSlot({ dayOfWeek: TUESDAY, startMinute: 960, endMinute: 900 })).toBe(false);
  });

  it('rejects a day outside 1..7 and minutes outside the day', () => {
    expect(validateSlot({ dayOfWeek: 0, ...afternoon })).toBe(false);
    expect(validateSlot({ dayOfWeek: 8, ...afternoon })).toBe(false);
    expect(validateSlot({ dayOfWeek: TUESDAY, startMinute: -1, endMinute: 60 })).toBe(false);
    expect(validateSlot({ dayOfWeek: TUESDAY, startMinute: 60, endMinute: 1440 })).toBe(false);
  });

  it('finds slots of the same module that overlap on the same day only', () => {
    expect(
      findOverlappingSlots([
        { dayOfWeek: TUESDAY, startMinute: 840, endMinute: 960 },
        { dayOfWeek: TUESDAY, startMinute: 900, endMinute: 1020 },
      ]),
    ).toEqual([0, 1]);
    expect(
      findOverlappingSlots([
        { dayOfWeek: TUESDAY, startMinute: 840, endMinute: 960 },
        { dayOfWeek: THURSDAY, startMinute: 840, endMinute: 960 },
        { dayOfWeek: TUESDAY, startMinute: 960, endMinute: 1080 },
      ]),
    ).toBeNull();
  });
});

describe('Bogota local time to UTC', () => {
  it('maps 14:00 in Bogota to 19:00 UTC', () => {
    expect(bogotaToUtc(day('2026-03-03'), 14 * 60).toISOString()).toBe('2026-03-03T19:00:00.000Z');
  });

  it('rolls over to the next UTC day for evening hours', () => {
    expect(bogotaToUtc(day('2026-03-03'), 20 * 60).toISOString()).toBe('2026-03-04T01:00:00.000Z');
  });

  it('keeps the same offset all year (no daylight saving)', () => {
    expect(bogotaToUtc(day('2026-07-07'), 14 * 60).toISOString()).toBe('2026-07-07T19:00:00.000Z');
  });
});

describe('weekday', () => {
  it('uses 1 for Monday and 7 for Sunday', () => {
    expect(isoWeekday(day('2026-03-02'))).toBe(1); // Monday
    expect(isoWeekday(day('2026-03-03'))).toBe(2);
    expect(isoWeekday(day('2026-03-08'))).toBe(7); // Sunday
  });
});

describe('weekly occurrences', () => {
  // 2026-03-02 is a Monday. Tuesdays from 2026-03-03 to 2026-04-28 (inclusive): 9 of them.
  const period = { startsOn: day('2026-03-02'), endsOn: day('2026-04-28') };
  const before = new Date('2026-01-01T00:00:00Z');
  const tuesday = { key: 'a', dayOfWeek: TUESDAY, ...afternoon };

  it('creates one occurrence per week on the chosen day, inclusive of the last day', () => {
    const result = occurrences({ ...period, schedules: [tuesday], holidays: new Set(), now: before });
    expect(result).toHaveLength(9);
    expect(result[0]?.startsAt.toISOString()).toBe('2026-03-03T19:00:00.000Z');
    expect(result[0]?.endsAt.toISOString()).toBe('2026-03-03T21:00:00.000Z');
    expect(result.at(-1)?.startsAt.toISOString()).toBe('2026-04-28T19:00:00.000Z');
  });

  it('includes both ends when the period starts and ends on the chosen day', () => {
    const result = occurrences({
      startsOn: day('2026-03-03'),
      endsOn: day('2026-03-17'),
      schedules: [tuesday],
      holidays: new Set(),
      now: before,
    });
    expect(result.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual([
      '2026-03-03',
      '2026-03-10',
      '2026-03-17',
    ]);
  });

  it('generates for every schedule and tags each occurrence with its schedule key', () => {
    const thursday = { key: 'b', dayOfWeek: THURSDAY, ...afternoon };
    const result = occurrences({ ...period, schedules: [tuesday, thursday], holidays: new Set(), now: before });
    expect(result.filter((o) => o.key === 'a')).toHaveLength(9);
    expect(result.filter((o) => o.key === 'b')).toHaveLength(8); // Thursdays 03-05 .. 04-23
  });

  it('skips holidays', () => {
    const result = occurrences({
      ...period,
      schedules: [tuesday],
      holidays: new Set(['2026-03-24']),
      now: before,
    });
    expect(result).toHaveLength(8);
    expect(result.some((o) => o.startsAt.toISOString().startsWith('2026-03-24'))).toBe(false);
  });

  it('skips sessions that already started when the period is under way', () => {
    // On Tuesday 2026-03-17 at 15:00 Bogota (20:00 UTC) the 14:00 session of that day has started
    const result = occurrences({
      ...period,
      schedules: [tuesday],
      holidays: new Set(),
      now: new Date('2026-03-17T20:00:00Z'),
    });
    expect(result[0]?.startsAt.toISOString()).toBe('2026-03-24T19:00:00.000Z');
    expect(result).toHaveLength(6);
  });

  it('keeps a session that has not started yet on the same day', () => {
    const result = occurrences({
      ...period,
      schedules: [tuesday],
      holidays: new Set(),
      now: new Date('2026-03-17T17:00:00Z'), // 12:00 Bogota
    });
    expect(result[0]?.startsAt.toISOString()).toBe('2026-03-17T19:00:00.000Z');
  });

  it('returns nothing when the period is shorter than a week and misses the day', () => {
    const result = occurrences({
      startsOn: day('2026-03-04'), // Wednesday
      endsOn: day('2026-03-06'), // Friday
      schedules: [tuesday],
      holidays: new Set(),
      now: before,
    });
    expect(result).toEqual([]);
  });

  it('returns nothing when the period is over', () => {
    const result = occurrences({
      ...period,
      schedules: [tuesday],
      holidays: new Set(),
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(result).toEqual([]);
  });
});
