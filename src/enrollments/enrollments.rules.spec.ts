import { describe, expect, it } from 'vitest';
import { canCancelSession, effectiveUntil, findStudentConflict } from './enrollments.rules.js';

const now = new Date('2026-11-17T15:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

describe('cancellation window', () => {
  it.each([
    [61, true],
    [60, true],
    [59, false],
  ])('a session %i minutes away -> %s', (minutes, allowed) => {
    expect(canCancelSession(at(minutes), now, 60)).toBe(allowed);
  });

  it('effectiveUntil adds exactly the configured minutes', () => {
    expect(effectiveUntil(now, 60).toISOString()).toBe('2026-11-17T16:00:00.000Z');
    expect(effectiveUntil(now, 90).toISOString()).toBe('2026-11-17T16:30:00.000Z');
  });
});

describe('student schedule conflicts', () => {
  const mine = [{ moduleName: 'Física', dayOfWeek: 2, startMinute: 840, endMinute: 960 }];

  it('finds an overlap on the same day', () => {
    const hit = findStudentConflict([{ dayOfWeek: 2, startMinute: 900, endMinute: 1020 }], mine);
    expect(hit?.moduleName).toBe('Física');
  });

  it('ending when another starts is not an overlap, on either side', () => {
    expect(findStudentConflict([{ dayOfWeek: 2, startMinute: 960, endMinute: 1080 }], mine)).toBeNull();
    expect(findStudentConflict([{ dayOfWeek: 2, startMinute: 720, endMinute: 840 }], mine)).toBeNull();
  });

  it('ignores other days', () => {
    expect(findStudentConflict([{ dayOfWeek: 3, startMinute: 840, endMinute: 960 }], mine)).toBeNull();
  });
});
