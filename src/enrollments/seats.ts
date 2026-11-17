import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface SessionSeats {
  sessionId: string;
  moduleId: string;
  startsAt: Date;
  capacity: number;
  attendees: number;
  freeSeats: number;
}

// Seats per future session (research.md R-1) for several modules in one query. Attendees are the
// distinct active students of the module with an ACTIVE enrollment, or a CANCELLED one whose
// effective_until is after the session starts, who have not skipped that session.
export async function sessionSeats(db: Db, moduleIds: readonly string[], now: Date): Promise<SessionSeats[]> {
  if (moduleIds.length === 0) return [];
  const rows = await db.$queryRaw<
    { sessionId: string; moduleId: string; startsAt: Date; capacity: number; attendees: number }[]
  >`
    SELECT s.id AS "sessionId", s.module_id AS "moduleId", s.starts_at AS "startsAt",
      r.capacity::int AS capacity,
      (
        SELECT COUNT(DISTINCT e.student_id)::int
        FROM enrollments e
        JOIN users u ON u.id = e.student_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
        WHERE e.module_id = s.module_id AND e.deleted_at IS NULL
          AND (e.status = 'ACTIVE' OR (e.status = 'CANCELLED' AND s.starts_at < e.effective_until))
          AND NOT EXISTS (
            SELECT 1 FROM session_absences a
            WHERE a.enrollment_id = e.id AND a.session_id = s.id AND a.deleted_at IS NULL
          )
      ) AS attendees
    FROM module_sessions s
    JOIN rooms r ON r.id = s.room_id
    WHERE s.module_id = ANY(${[...moduleIds]}::uuid[])
      AND s.deleted_at IS NULL
      AND s.starts_at > ${now}
      AND s.status IN ('SCHEDULED', 'RESCHEDULED')
    ORDER BY s.starts_at`;
  return rows.map((row) => ({ ...row, freeSeats: Math.max(0, row.capacity - row.attendees) }));
}

// Free seats of a module: the fewest among its future sessions, never negative; null when it has none.
export function moduleSeats(seats: readonly SessionSeats[], moduleId: string): number | null {
  let min: number | null = null;
  for (const seat of seats) {
    if (seat.moduleId === moduleId && (min === null || seat.freeSeats < min)) min = seat.freeSeats;
  }
  return min;
}
