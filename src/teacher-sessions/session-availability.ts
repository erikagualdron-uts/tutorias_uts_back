import type { Prisma } from '@prisma/client';
import { BOGOTA_UTC_OFFSET_HOURS, bogotaCalendarDay } from '../common/clock.js';
import { ATTENDS_SESSION } from '../enrollments/seats.js';
import { formatTime, isoWeekday } from '../modules/sessions.rules.js';
import type { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface ResourceConflict {
  kind: 'room' | 'teacher';
  conflict: { moduleName: string; dayOfWeek: number; startTime: string; endTime: string };
}

// Weekday and local hours (Bogota) of a session, to name the one that collides.
function localParts(startsAt: Date, endsAt: Date) {
  const minutes = (d: Date) => {
    const shifted = new Date(d.getTime() - BOGOTA_UTC_OFFSET_HOURS * 3_600_000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  };
  return {
    dayOfWeek: isoWeekday(bogotaCalendarDay(startsAt)),
    startTime: formatTime(minutes(startsAt)),
    endTime: formatTime(minutes(endsAt)),
  };
}

// Another live session of the same teacher or room that overlaps [startsAt, endsAt) (half-open: ending
// when another starts is not an overlap). Sessions, not weekly slots, so moved sessions count. The
// teacher is checked first, then the room, like `assertFree` of the modules.
export async function findResourceConflict(
  db: Db,
  params: { roomId: string; teacherId: string; startsAt: Date; endsAt: Date; ignoreSessionIds: readonly string[] },
): Promise<ResourceConflict | null> {
  const rows = await db.moduleSession.findMany({
    where: {
      id: { notIn: [...params.ignoreSessionIds] },
      deletedAt: null,
      status: { in: ['SCHEDULED', 'RESCHEDULED'] },
      startsAt: { lt: params.endsAt },
      endsAt: { gt: params.startsAt },
      module: { deletedAt: null },
      OR: [{ teacherId: params.teacherId }, { roomId: params.roomId }],
    },
    include: { module: { select: { name: true } } },
    orderBy: { startsAt: 'asc' },
  });
  const byTeacher = rows.find((r) => r.teacherId === params.teacherId);
  const hit = byTeacher ?? rows[0];
  if (!hit) return null;
  return {
    kind: byTeacher ? 'teacher' : 'room',
    conflict: { moduleName: hit.module.name, ...localParts(hit.startsAt, hit.endsAt) },
  };
}

// How many of the students who attend `sessionId` already attend another session of another module
// that overlaps the new interval. Only a count: never who (privacy, Constitution IV).
export async function countStudentConflicts(
  db: Db,
  params: { sessionId: string; startsAt: Date; endsAt: Date },
): Promise<number> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(DISTINCT e.student_id)::int AS count
    FROM module_sessions s
    JOIN enrollments e ON e.module_id = s.module_id
    JOIN users u ON u.id = e.student_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
    WHERE s.id = ${params.sessionId}::uuid
      AND ${ATTENDS_SESSION}
      AND EXISTS (
        SELECT 1
        FROM module_sessions o
        JOIN enrollments e2 ON e2.module_id = o.module_id AND e2.student_id = e.student_id
        WHERE o.module_id <> s.module_id
          AND o.deleted_at IS NULL
          AND o.status IN ('SCHEDULED', 'RESCHEDULED')
          AND o.starts_at < ${params.endsAt}
          AND o.ends_at > ${params.startsAt}
          AND e2.deleted_at IS NULL
          AND (e2.status = 'ACTIVE' OR (e2.status = 'CANCELLED' AND o.starts_at < e2.effective_until))
          AND NOT EXISTS (
            SELECT 1 FROM session_absences a2
            WHERE a2.enrollment_id = e2.id AND a2.session_id = o.id AND a2.deleted_at IS NULL
          )
      )`;
  return rows[0]?.count ?? 0;
}
