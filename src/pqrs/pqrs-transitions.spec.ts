import { describe, expect, it } from 'vitest';
import { canRespond, canResolve, canTransition } from './pqrs-transitions.js';

type Status = 'FILED' | 'IN_REVIEW' | 'RESOLVED';
const ALL: Status[] = ['FILED', 'IN_REVIEW', 'RESOLVED'];

describe('PQRS transitions (spec 017)', () => {
  it('allows only FILED -> IN_REVIEW and IN_REVIEW -> RESOLVED', () => {
    const allowed = ALL.flatMap((from) => ALL.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`));
    expect(allowed).toEqual(['FILED>IN_REVIEW', 'IN_REVIEW>RESOLVED']);
  });

  it('never leaves RESOLVED, goes back or skips a state', () => {
    expect(canTransition('RESOLVED', 'IN_REVIEW')).toBe(false);
    expect(canTransition('IN_REVIEW', 'FILED')).toBe(false);
    expect(canTransition('FILED', 'RESOLVED')).toBe(false);
    expect(canTransition('FILED', 'FILED')).toBe(false);
  });

  it('lets the CAE reply only while the PQRS is IN_REVIEW', () => {
    expect(ALL.filter(canRespond)).toEqual(['IN_REVIEW']);
  });

  it('resolves only from IN_REVIEW and with at least one reply', () => {
    expect(canResolve('IN_REVIEW', 1)).toBe(true);
    expect(canResolve('IN_REVIEW', 0)).toBe(false);
    expect(canResolve('FILED', 3)).toBe(false);
    expect(canResolve('RESOLVED', 3)).toBe(false);
  });
});
