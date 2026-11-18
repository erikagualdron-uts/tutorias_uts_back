import { AppException } from '../common/errors/app.exception.js';
import { parseCalendarDay } from '../periods/periods.rules.js';

const DAY_MS = 86_400_000;
export const MAX_CALENDAR_DAYS = 7;

// The days (Bogota calendar days at UTC midnight, both included) of a calendar request.
export function parseCalendarRange(from?: string, to?: string): { from: Date; to: Date } {
  const start = from === undefined ? null : parseCalendarDay(from);
  const end = to === undefined ? null : parseCalendarDay(to);
  if (!start || !end) throw new AppException(400, 'VALIDATION_FAILED', 'from and to must be calendar days');
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days < 1) throw new AppException(400, 'VALIDATION_FAILED', 'to must not be before from');
  if (days > MAX_CALENDAR_DAYS) {
    throw new AppException(400, 'VALIDATION_FAILED', `The range is at most ${MAX_CALENDAR_DAYS} days`);
  }
  return { from: start, to: end };
}

// The active period; without one, the closed period that ended last (read only); otherwise none.
export function pickCalendarPeriod<T>(active: T | null, lastClosed: T | null): T | null {
  return active ?? lastClosed;
}
