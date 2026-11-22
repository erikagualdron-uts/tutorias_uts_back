import type { Role } from '@prisma/client';

// Pure rules of who can chat with whom (spec 018). The service reads the facts from live rows
// (accounts, enrollments, modules, periods) and these functions decide; nothing is stored.
export type ReadOnlyReason = 'NO_SHARED_MODULE' | 'PERIOD_CLOSED' | 'PARTNER_UNAVAILABLE';

// The CAE talks with teachers and a teacher with the students of their modules; nothing else.
export function canPair(a: Role, b: Role): boolean {
  const pair = [a, b].sort().join('+');
  return pair === 'SUPERADMIN+TEACHER' || pair === 'STUDENT+TEACHER';
}

export interface DirectFacts {
  meRole: Role;
  partnerRole: Role;
  // Active and not deleted.
  partnerAvailable: boolean;
  // The student has an ACTIVE enrollment in a live module of the teacher, in a period that is not closed.
  sharedActiveModule: boolean;
}

export type WriteDecision = { canWrite: true } | { canWrite: false; reason: ReadOnlyReason };

export function directDecision({ meRole, partnerRole, partnerAvailable, sharedActiveModule }: DirectFacts): WriteDecision {
  if (!partnerAvailable) return { canWrite: false, reason: 'PARTNER_UNAVAILABLE' };
  const needsModule = meRole === 'STUDENT' || partnerRole === 'STUDENT';
  if (needsModule && !sharedActiveModule) return { canWrite: false, reason: 'NO_SHARED_MODULE' };
  return { canWrite: true };
}

export interface ModuleFacts {
  isModuleTeacher: boolean;
  hasActiveEnrollment: boolean;
  periodClosed: boolean;
}

export type ModuleDecision = { access: false } | ({ access: true; canAnnounce: boolean } & WriteDecision);

// Someone who is neither the teacher nor actively enrolled has no access: the chat does not exist for them.
export function moduleDecision({ isModuleTeacher, hasActiveEnrollment, periodClosed }: ModuleFacts): ModuleDecision {
  if (!isModuleTeacher && !hasActiveEnrollment) return { access: false };
  if (periodClosed) return { access: true, canWrite: false, reason: 'PERIOD_CLOSED', canAnnounce: false };
  return { access: true, canWrite: true, canAnnounce: isModuleTeacher };
}
