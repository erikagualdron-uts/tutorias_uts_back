import { describe, expect, it } from 'vitest';
import { canPair, directDecision, moduleDecision } from './chat-access.js';

describe('who can chat with whom (spec 018, FR-001)', () => {
  it.each([
    ['SUPERADMIN', 'TEACHER', true],
    ['TEACHER', 'SUPERADMIN', true],
    ['TEACHER', 'STUDENT', true],
    ['STUDENT', 'TEACHER', true],
    ['STUDENT', 'STUDENT', false],
    ['STUDENT', 'SUPERADMIN', false],
    ['SUPERADMIN', 'STUDENT', false],
    ['SUPERADMIN', 'SUPERADMIN', false],
    ['TEACHER', 'TEACHER', false],
  ] as const)('%s with %s is %s', (a, b, allowed) => {
    expect(canPair(a, b)).toBe(allowed);
  });
});

describe('direct conversation: can the user write?', () => {
  const facts = (overrides: Partial<Parameters<typeof directDecision>[0]> = {}) => ({
    meRole: 'STUDENT' as const,
    partnerRole: 'TEACHER' as const,
    partnerAvailable: true,
    sharedActiveModule: true,
    ...overrides,
  });

  it('lets a student and a teacher write while they share an active module', () => {
    expect(directDecision(facts())).toEqual({ canWrite: true });
    expect(directDecision(facts({ meRole: 'TEACHER', partnerRole: 'STUDENT' }))).toEqual({ canWrite: true });
  });

  it('turns a student and teacher conversation read-only when they stop sharing a module', () => {
    expect(directDecision(facts({ sharedActiveModule: false }))).toEqual({ canWrite: false, reason: 'NO_SHARED_MODULE' });
  });

  it('lets the CAE and a teacher write without any module', () => {
    expect(directDecision(facts({ meRole: 'SUPERADMIN', partnerRole: 'TEACHER', sharedActiveModule: false }))).toEqual({ canWrite: true });
    expect(directDecision(facts({ meRole: 'TEACHER', partnerRole: 'SUPERADMIN', sharedActiveModule: false }))).toEqual({ canWrite: true });
  });

  it('is read-only when the other account is unavailable, before any other reason', () => {
    expect(directDecision(facts({ partnerAvailable: false }))).toEqual({ canWrite: false, reason: 'PARTNER_UNAVAILABLE' });
    expect(directDecision(facts({ partnerAvailable: false, sharedActiveModule: false }))).toEqual({ canWrite: false, reason: 'PARTNER_UNAVAILABLE' });
    expect(directDecision(facts({ meRole: 'SUPERADMIN', partnerRole: 'TEACHER', partnerAvailable: false }))).toEqual({ canWrite: false, reason: 'PARTNER_UNAVAILABLE' });
  });
});

describe('module conversation: access, writing and announcing', () => {
  const facts = (overrides: Partial<Parameters<typeof moduleDecision>[0]> = {}) => ({
    isModuleTeacher: false,
    hasActiveEnrollment: true,
    periodClosed: false,
    ...overrides,
  });

  it('gives a student with an active enrollment access to write but not to announce', () => {
    expect(moduleDecision(facts())).toEqual({ access: true, canWrite: true, canAnnounce: false });
  });

  it('gives the teacher of the module access to write and to announce', () => {
    expect(moduleDecision(facts({ isModuleTeacher: true, hasActiveEnrollment: false }))).toEqual({ access: true, canWrite: true, canAnnounce: true });
  });

  it('gives nobody else any access: the conversation does not exist for them', () => {
    expect(moduleDecision(facts({ hasActiveEnrollment: false }))).toEqual({ access: false });
  });

  it('is read-only for everyone when the period is closed, and nobody can announce', () => {
    expect(moduleDecision(facts({ periodClosed: true }))).toEqual({ access: true, canWrite: false, reason: 'PERIOD_CLOSED', canAnnounce: false });
    expect(moduleDecision(facts({ isModuleTeacher: true, hasActiveEnrollment: false, periodClosed: true }))).toEqual({
      access: true,
      canWrite: false,
      reason: 'PERIOD_CLOSED',
      canAnnounce: false,
    });
  });
});
