import { rangesOverlap, type Slot } from '../modules/sessions.rules.js';

const MINUTE_MS = 60_000;

// A student may cancel while the session is at least `leadMinutes` away: exactly 60 is allowed.
export function canCancelSession(startsAt: Date, now: Date, leadMinutes: number): boolean {
  return startsAt.getTime() - now.getTime() >= leadMinutes * MINUTE_MS;
}

// Sessions that start before this moment keep the student after the module is cancelled (R-4).
export function effectiveUntil(now: Date, leadMinutes: number): Date {
  return new Date(now.getTime() + leadMinutes * MINUTE_MS);
}

export interface OwnSlot extends Slot {
  moduleName: string;
}

// First slot of the student's other modules that overlaps one of the target module's slots
// (same weekday, half-open ranges), or null.
export function findStudentConflict(target: readonly Slot[], mine: readonly OwnSlot[]): OwnSlot | null {
  for (const own of mine) {
    const hit = target.some(
      (slot) =>
        slot.dayOfWeek === own.dayOfWeek &&
        rangesOverlap(slot.startMinute, slot.endMinute, own.startMinute, own.endMinute),
    );
    if (hit) return own;
  }
  return null;
}
