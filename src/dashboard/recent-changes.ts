import type { Prisma } from '@prisma/client';

// A recent change is a session the teacher rescheduled or cancelled (R-4). Holiday cancellations come
// from the calendar, not from a decision, so they stay out; a restored session is SCHEDULED again.
export const RECENT_CHANGE_WHERE = {
  deletedAt: null,
  status: { in: ['RESCHEDULED', 'CANCELLED'] },
  OR: [{ cancelReason: null }, { cancelReason: { not: 'HOLIDAY' } }],
  module: { deletedAt: null },
} satisfies Prisma.ModuleSessionWhereInput;

export const RECENT_CHANGE_INCLUDE = { module: { select: { id: true, name: true } } } satisfies Prisma.ModuleSessionInclude;

export const RECENT_CHANGE_ORDER = [{ updatedAt: 'desc' }, { id: 'desc' }] satisfies Prisma.ModuleSessionOrderByWithRelationInput[];

type ChangeRow = Prisma.ModuleSessionGetPayload<{ include: typeof RECENT_CHANGE_INCLUDE }>;

export const changeView = (s: ChangeRow) => ({
  sessionId: s.id,
  moduleId: s.module.id,
  moduleName: s.module.name,
  kind: s.status as 'RESCHEDULED' | 'CANCELLED',
  originalStartsAt: s.originalStartsAt,
  startsAt: s.startsAt,
  changedAt: s.updatedAt,
});
