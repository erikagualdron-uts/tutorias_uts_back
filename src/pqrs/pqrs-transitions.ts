import type { PqrsStatus } from '@prisma/client';

const NEXT: Record<PqrsStatus, PqrsStatus | null> = { FILED: 'IN_REVIEW', IN_REVIEW: 'RESOLVED', RESOLVED: null };

export const canTransition = (from: PqrsStatus, to: PqrsStatus) => NEXT[from] === to;

export const canRespond = (status: PqrsStatus) => status === 'IN_REVIEW';

export const canResolve = (status: PqrsStatus, messageCount: number) =>
  canTransition(status, 'RESOLVED') && messageCount > 0;
