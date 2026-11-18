import { endOfDayInBogotaUtc } from '../common/clock.js';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' -> Date at UTC midnight, or null when it is not a real calendar day.
export function parseCalendarDay(value: string): Date | null {
  const match = DAY.exec(value);
  if (!match) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const roundTrip = date.toISOString().slice(0, 10);
  return roundTrip === value ? date : null;
}

export function formatCalendarDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// FR-008: the end must be strictly after the start.
export function endsAfterStart(startsOn: Date, endsOn: Date): boolean {
  return endsOn.getTime() > startsOn.getTime();
}

// FR-012: a period is over once its last day ends in Bogota.
export function hasEnded(endsOn: Date, now: Date): boolean {
  return now.getTime() >= endOfDayInBogotaUtc(endsOn).getTime();
}
