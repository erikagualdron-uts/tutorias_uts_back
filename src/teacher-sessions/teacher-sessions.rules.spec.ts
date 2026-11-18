import { describe, expect, it } from 'vitest';
import {
  bogotaWeek,
  canChangeSession,
  isWithinHours,
  sessionChangeActions,
  shiftSession,
  validateReschedule,
} from './teacher-sessions.rules.js';

const now = new Date('2030-01-08T15:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const utc = (iso: string) => new Date(iso);

describe('change window', () => {
  it.each([
    [121, true],
    [120, true],
    [119, false],
  ])('a session %i minutes away -> %s', (minutes, allowed) => {
    expect(canChangeSession(at(minutes), now, 120)).toBe(allowed);
  });
});

describe('bogotaWeek', () => {
  it('runs from Monday 00:00 to the next Monday 00:00 in Bogota', () => {
    // 2030-01-08 is a Tuesday
    const week = bogotaWeek(utc('2030-01-08T19:00:00Z'));
    expect(week.start.toISOString()).toBe('2030-01-07T05:00:00.000Z');
    expect(week.end.toISOString()).toBe('2030-01-14T05:00:00.000Z');
  });

  it('keeps Sunday night in its own week and puts Monday 00:00 in the next', () => {
    // Sunday 2030-01-13 23:30 Bogota = Monday 04:30Z
    expect(bogotaWeek(utc('2030-01-14T04:30:00Z')).start.toISOString()).toBe('2030-01-07T05:00:00.000Z');
    expect(bogotaWeek(utc('2030-01-14T05:00:00Z')).start.toISOString()).toBe('2030-01-14T05:00:00.000Z');
  });
});

describe('shiftSession', () => {
  it('moves both ends the same amount and keeps the duration', () => {
    const moved = shiftSession(utc('2030-01-08T19:00:00Z'), utc('2030-01-08T21:00:00Z'), 24 * 3_600_000);
    expect(moved.startsAt.toISOString()).toBe('2030-01-09T19:00:00.000Z');
    expect(moved.endsAt.toISOString()).toBe('2030-01-09T21:00:00.000Z');
  });
});

describe('validateReschedule', () => {
  const base = {
    currentStart: utc('2030-01-08T19:00:00Z'), // Tuesday 14:00 Bogota
    now,
    periodStartsOn: utc('2030-01-07T00:00:00Z'),
    periodEndsOn: utc('2030-03-03T00:00:00Z'),
    holidayDays: new Set(['2030-01-10']),
  };
  const check = (newStart: string, extra: object = {}) => validateReschedule({ ...base, ...extra, newStart: utc(newStart) });

  it('accepts another day and hour of the same week', () => {
    expect(check('2030-01-09T15:00:00Z')).toBeNull();
  });

  it('refuses no change, the past, another week, outside the period and a holiday, in that order', () => {
    expect(check('2030-01-08T19:00:00Z')?.reason).toBe('NO_CHANGE');
    expect(check('2030-01-08T14:00:00Z')?.reason).toBe('PAST');
    expect(check('2030-01-14T19:00:00Z')?.reason).toBe('OUT_OF_WEEK');
    expect(check('2030-01-07T20:00:00Z', { now: utc('2030-01-01T00:00:00Z'), periodStartsOn: utc('2030-01-08T00:00:00Z') })?.reason).toBe('OUT_OF_PERIOD');
    expect(check('2030-01-10T19:00:00Z')).toEqual({ reason: 'HOLIDAY', date: '2030-01-10' });
  });

  it('allows Sunday of the same week and refuses the next Monday 00:00', () => {
    expect(check('2030-01-13T15:00:00Z')).toBeNull();
    expect(check('2030-01-14T05:00:00Z')?.reason).toBe('OUT_OF_WEEK');
  });
});

describe('isWithinHours', () => {
  const earliest = 360;
  const latest = 1080;
  it('ends at 18:00 sharp is allowed, 18:15 is not', () => {
    expect(isWithinHours(utc('2030-01-08T21:00:00Z'), utc('2030-01-08T23:00:00Z'), earliest, latest)).toBe(true); // 16:00-18:00
    expect(isWithinHours(utc('2030-01-08T21:15:00Z'), utc('2030-01-08T23:15:00Z'), earliest, latest)).toBe(false); // 16:15-18:15
  });
  it('refuses starting before 06:00', () => {
    expect(isWithinHours(utc('2030-01-08T10:45:00Z'), utc('2030-01-08T12:45:00Z'), earliest, latest)).toBe(false); // 05:45
    expect(isWithinHours(utc('2030-01-08T11:00:00Z'), utc('2030-01-08T13:00:00Z'), earliest, latest)).toBe(true); // 06:00
  });
});

describe('sessionChangeActions', () => {
  const base = {
    mine: true,
    readOnly: false,
    status: 'SCHEDULED' as const,
    cancelReason: null,
    startsAt: at(180),
    now,
    leadMinutes: 120,
  };

  it('offers reschedule and cancel on a scheduled session', () => {
    expect(sessionChangeActions(base)).toEqual({ canReschedule: true, canCancel: true, canRestore: false, blockReason: null });
  });

  it('blocks at 119 minutes with the window rule', () => {
    expect(sessionChangeActions({ ...base, startsAt: at(119) }).blockReason).toBe('WINDOW_PASSED');
    expect(sessionChangeActions({ ...base, startsAt: at(120) }).canCancel).toBe(true);
  });

  it('offers only restore on a session the teacher cancelled', () => {
    const result = sessionChangeActions({ ...base, status: 'CANCELLED', cancelReason: 'TEACHER' });
    expect(result).toEqual({ canReschedule: false, canCancel: false, canRestore: true, blockReason: null });
  });

  it('offers nothing on a holiday cancellation, a closed period, a past session or a stranger\'s session', () => {
    expect(sessionChangeActions({ ...base, status: 'CANCELLED', cancelReason: 'HOLIDAY' }).blockReason).toBe('CANCELLED_BY_OTHER');
    expect(sessionChangeActions({ ...base, readOnly: true }).blockReason).toBe('PERIOD_CLOSED');
    expect(sessionChangeActions({ ...base, startsAt: at(-5) }).blockReason).toBe('PAST');
    expect(sessionChangeActions({ ...base, mine: false })).toEqual({ canReschedule: false, canCancel: false, canRestore: false, blockReason: null });
  });
});
