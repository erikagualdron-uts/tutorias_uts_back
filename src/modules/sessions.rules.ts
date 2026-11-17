import { BOGOTA_UTC_OFFSET_HOURS } from '../common/clock.js';

// Pure rules of weekly slots and session dates (research.md R-3 and R-4). Times are minutes from
// midnight in America/Bogota. Days of the week are 1 (Monday) to 7 (Sunday).

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LAST_MINUTE = 1439; // 23:59: a slot never crosses midnight
const DAY_MS = 86_400_000;

export interface Slot {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface Occurrence {
  key: string;
  startsAt: Date;
  endsAt: Date;
}

// 'HH:mm' -> minutes from midnight, or null when it is not a time between 00:00 and 23:59.
export function parseTime(value: string): number | null {
  const match = TIME.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

// Half-open ranges [start, end): ending exactly when another starts is not an overlap.
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function validateSlot(slot: Slot): boolean {
  return (
    Number.isInteger(slot.dayOfWeek) &&
    slot.dayOfWeek >= 1 &&
    slot.dayOfWeek <= 7 &&
    Number.isInteger(slot.startMinute) &&
    Number.isInteger(slot.endMinute) &&
    slot.startMinute >= 0 &&
    slot.startMinute < slot.endMinute &&
    slot.endMinute <= LAST_MINUTE
  );
}

// Indexes of the first two slots of the same module that overlap, or null when none does.
export function findOverlappingSlots(slots: readonly Slot[]): [number, number] | null {
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!;
      const b = slots[j]!;
      if (
        a.dayOfWeek === b.dayOfWeek &&
        rangesOverlap(a.startMinute, a.endMinute, b.startMinute, b.endMinute)
      ) {
        return [i, j];
      }
    }
  }
  return null;
}

// Calendar day (Date at UTC midnight) + local minutes in Bogota -> the UTC instant. Bogota is
// UTC-5 all year, so the conversion is one constant offset.
export function bogotaToUtc(calendarDay: Date, minute: number): Date {
  return new Date(
    Date.UTC(
      calendarDay.getUTCFullYear(),
      calendarDay.getUTCMonth(),
      calendarDay.getUTCDate(),
      BOGOTA_UTC_OFFSET_HOURS,
      minute,
    ),
  );
}

export function isoWeekday(calendarDay: Date): number {
  return ((calendarDay.getUTCDay() + 6) % 7) + 1;
}

export function dayKey(calendarDay: Date): string {
  return calendarDay.toISOString().slice(0, 10);
}

export interface OccurrencesInput {
  startsOn: Date;
  endsOn: Date;
  schedules: readonly (Slot & { key: string })[];
  holidays: ReadonlySet<string>; // 'YYYY-MM-DD'
  now: Date;
}

// One session per week and slot from startsOn to endsOn (both inclusive), without holidays and
// without sessions that already started.
export function occurrences(input: OccurrencesInput): Occurrence[] {
  const result: Occurrence[] = [];
  for (const slot of input.schedules) {
    const shift = (slot.dayOfWeek - isoWeekday(input.startsOn) + 7) % 7;
    let current = new Date(input.startsOn.getTime() + shift * DAY_MS);
    for (; current.getTime() <= input.endsOn.getTime(); current = new Date(current.getTime() + 7 * DAY_MS)) {
      if (input.holidays.has(dayKey(current))) continue;
      const startsAt = bogotaToUtc(current, slot.startMinute);
      if (startsAt.getTime() <= input.now.getTime()) continue;
      result.push({ key: slot.key, startsAt, endsAt: bogotaToUtc(current, slot.endMinute) });
    }
  }
  return result;
}
