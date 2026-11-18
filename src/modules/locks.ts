import type { Prisma } from '@prisma/client';
import { AppException } from '../common/errors/app.exception.js';

// Shared lock on the period row (research.md R-2): a close that arrives meanwhile waits for this
// transaction, and one that already happened is seen here as CLOSED.
export async function lockWritablePeriod(tx: Prisma.TransactionClient, periodId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM academic_periods WHERE id = ${periodId}::uuid AND deleted_at IS NULL FOR SHARE`;
  if (locked.length === 0) throw new AppException(404, 'NOT_FOUND', 'Period not found');
  const period = await tx.academicPeriod.findUniqueOrThrow({ where: { id: periodId } });
  if (period.status === 'CLOSED') {
    throw new AppException(409, 'PERIOD_CLOSED_READ_ONLY', 'A closed period is read-only');
  }
  return period;
}

// Shared lock on the period, then an exclusive one on the module (a concurrent enrollment locks
// the same row, so the enrolled count read afterwards cannot change under this transaction).
export async function lockModule(tx: Prisma.TransactionClient, id: string, periodId: string) {
  await lockWritablePeriod(tx, periodId);
  await tx.$queryRaw`SELECT id FROM modules WHERE id = ${id}::uuid FOR UPDATE`;
  const module = await tx.module.findFirst({ where: { id, deletedAt: null } });
  if (!module) throw new AppException(404, 'NOT_FOUND', 'Module not found');
  return module;
}

// Fourth and fifth locks of a teacher change (spec 012, D-096): the rooms and then the teachers of the
// sessions that move, each ordered by id, so two changes that touch the same room or teacher queue
// instead of both passing the availability check.
export async function lockRoomsAndTeachers(
  tx: Prisma.TransactionClient,
  roomIds: readonly string[],
  teacherIds: readonly string[],
) {
  if (roomIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM rooms WHERE id = ANY(${[...roomIds]}::uuid[]) ORDER BY id FOR UPDATE`;
  }
  if (teacherIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ANY(${[...teacherIds]}::uuid[]) ORDER BY id FOR UPDATE`;
  }
}
