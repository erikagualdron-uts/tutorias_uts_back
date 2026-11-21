import { Prisma } from '@prisma/client';
import { ATTENDS_SESSION } from '../enrollments/seats.js';
import type { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

export type Scope = { sessionIds: readonly string[] } | { moduleId: string; after: Date };

// Students who must hear about a change, with the sessions of the change they attend (FR-003).
// A student attends a session when the enrollment is ACTIVE, or CANCELLED with the session starting
// before effective_until, and has no live absence for it (the shared ATTENDS_SESSION fragment of the
// seat count). Only active, not deleted accounts. Read when the event is processed, never copied
// into the event (FR-004).
//   - `sessionIds`: the sessions the event names.
//   - `moduleId` + `after`: the module's live sessions starting after `after` (teacher or room change).
export async function attendingStudents(db: Db, scope: Scope): Promise<Map<string, string[]>> {
  const target =
    'sessionIds' in scope
      ? Prisma.sql`s.id = ANY(${[...scope.sessionIds]}::uuid[])`
      : Prisma.sql`s.module_id = ${scope.moduleId}::uuid AND s.deleted_at IS NULL
          AND s.status IN ('SCHEDULED', 'RESCHEDULED') AND s.starts_at > ${scope.after}`;
  const rows = await db.$queryRaw<{ userId: string; sessionId: string }[]>`
    SELECT DISTINCT e.student_id AS "userId", s.id AS "sessionId"
    FROM module_sessions s
    JOIN enrollments e ON e.module_id = s.module_id
    JOIN users u ON u.id = e.student_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    WHERE ${target} AND ${ATTENDS_SESSION}`;
  const byStudent = new Map<string, string[]>();
  for (const { userId, sessionId } of rows) {
    byStudent.set(userId, [...(byStudent.get(userId) ?? []), sessionId]);
  }
  return byStudent;
}
