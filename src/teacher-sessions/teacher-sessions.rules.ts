import { BOGOTA_UTC_OFFSET_HOURS, bogotaCalendarDay } from '../common/clock.js';
import { bogotaToUtc, dayKey, isoWeekday } from '../modules/sessions.rules.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type ChangeBlockReason = 'WINDOW_PASSED' | 'PERIOD_CLOSED' | 'PAST' | 'CANCELLED_BY_OTHER';
export type InvalidDateReason = 'NO_CHANGE' | 'PAST' | 'OUT_OF_WEEK' | 'OUT_OF_PERIOD' | 'HOLIDAY';

// A teacher may change a session while it is at least `leadMinutes` away: exactly 120 is allowed.
export function canChangeSession(startsAt: Date, now: Date, leadMinutes: number): boolean {
  return startsAt.getTime() - now.getTime() >= leadMinutes * MINUTE_MS;
}

// Monday 00:00 (included) to the next Monday 00:00 (excluded) of the Bogota week of `instant`, in UTC.
export function bogotaWeek(instant: Date): { start: Date; end: Date } {
  const day = bogotaCalendarDay(instant);
  const monday = new Date(day.getTime() - (isoWeekday(day) - 1) * DAY_MS);
  return { start: bogotaToUtc(monday, 0), end: bogotaToUtc(new Date(monday.getTime() + 7 * DAY_MS), 0) };
}

export const shiftSession = (startsAt: Date, endsAt: Date, deltaMs: number) => ({
  startsAt: new Date(startsAt.getTime() + deltaMs),
  endsAt: new Date(endsAt.getTime() + deltaMs),
});

export interface RescheduleCheck {
  currentStart: Date;
  newStart: Date;
  now: Date;
  periodStartsOn: Date;
  periodEndsOn: Date;
  holidayDays: ReadonlySet<string>;
}

// The first rule the new start breaks, in the order of the spec, or null.
export function validateReschedule(check: RescheduleCheck): { reason: InvalidDateReason; date?: string } | null {
  const { currentStart, newStart, now } = check;
  if (newStart.getTime() === currentStart.getTime()) return { reason: 'NO_CHANGE' };
  if (newStart.getTime() <= now.getTime()) return { reason: 'PAST' };
  const week = bogotaWeek(currentStart);
  if (newStart < week.start || newStart >= week.end) return { reason: 'OUT_OF_WEEK' };
  const day = bogotaCalendarDay(newStart);
  if (day < check.periodStartsOn || day > check.periodEndsOn) return { reason: 'OUT_OF_PERIOD' };
  const key = dayKey(day);
  if (check.holidayDays.has(key)) return { reason: 'HOLIDAY', date: key };
  return null;
}

// A session starts at or after `earliestMinute` and ends at or before `latestMinute` (Bogota time).
export function isWithinHours(startsAt: Date, endsAt: Date, earliestMinute: number, latestMinute: number): boolean {
  const local = (d: Date) => {
    const shifted = new Date(d.getTime() - BOGOTA_UTC_OFFSET_HOURS * 3_600_000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  };
  const start = local(startsAt);
  const end = start + Math.round((endsAt.getTime() - startsAt.getTime()) / MINUTE_MS);
  return start >= earliestMinute && end <= latestMinute;
}

export interface ChangeActionsInput {
  mine: boolean;
  readOnly: boolean;
  status: 'SCHEDULED' | 'RESCHEDULED' | 'CANCELLED';
  cancelReason: 'HOLIDAY' | 'TEACHER' | null;
  startsAt: Date;
  now: Date;
  leadMinutes: number;
}

// What the teacher can do with a session and, when nothing, the rule that blocks it.
export function sessionChangeActions(input: ChangeActionsInput): {
  canReschedule: boolean;
  canCancel: boolean;
  canRestore: boolean;
  blockReason: ChangeBlockReason | null;
} {
  const none = (blockReason: ChangeBlockReason | null) => ({
    canReschedule: false,
    canCancel: false,
    canRestore: false,
    blockReason,
  });
  if (!input.mine) return none(null);
  if (input.readOnly) return none('PERIOD_CLOSED');
  if (input.startsAt.getTime() <= input.now.getTime()) return none('PAST');
  if (input.status === 'CANCELLED' && input.cancelReason !== 'TEACHER') return none('CANCELLED_BY_OTHER');
  if (!canChangeSession(input.startsAt, input.now, input.leadMinutes)) return none('WINDOW_PASSED');
  if (input.status === 'CANCELLED') return { canReschedule: false, canCancel: false, canRestore: true, blockReason: null };
  return { canReschedule: true, canCancel: true, canRestore: false, blockReason: null };
}
