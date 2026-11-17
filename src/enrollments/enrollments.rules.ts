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

export type SessionBlockReason = 'WINDOW_PASSED' | 'PERIOD_CLOSED' | 'SESSION_CANCELLED' | 'NO_SEAT';

export interface SessionActionInput {
  enrolled: boolean; // the student has an ACTIVE enrollment in the module
  readOnly: boolean; // the period is CLOSED
  status: 'SCHEDULED' | 'RESCHEDULED' | 'CANCELLED';
  startsAt: Date;
  now: Date;
  leadMinutes: number;
  absent: boolean; // the student already skipped this session
  freeSeats: number;
}

// The single rule behind `canCancel` / `canRestore` (detail) and the cancel / restore actions.
export function sessionActions(input: SessionActionInput): {
  canCancel: boolean;
  canRestore: boolean;
  blockReason: SessionBlockReason | null;
} {
  const none = (blockReason: SessionBlockReason | null) => ({ canCancel: false, canRestore: false, blockReason });
  if (!input.enrolled) return none(null);
  if (input.readOnly) return none('PERIOD_CLOSED');
  if (input.status === 'CANCELLED') return none('SESSION_CANCELLED');
  if (!canCancelSession(input.startsAt, input.now, input.leadMinutes)) return none('WINDOW_PASSED');
  if (!input.absent) return { canCancel: true, canRestore: false, blockReason: null };
  return input.freeSeats >= 1 ? { canCancel: false, canRestore: true, blockReason: null } : none('NO_SEAT');
}
