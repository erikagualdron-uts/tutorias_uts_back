import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { bogotaToUtc } from '../modules/sessions.rules.js';
import { calendarMeta } from '../periods/calendar-meta.js';
import { PeriodsService } from '../periods/periods.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseCalendarRange } from '../teacher-sessions/calendar.rules.js';
import type { StudentCalendarQueryDto } from './dto/student-calendar-query.dto.js';
import { ENROLLED_IN_SESSION } from './seats.js';

const DAY_MS = 86_400_000;

interface Row {
  id: string;
  moduleId: string;
  moduleName: string;
  teacherName: string | null;
  roomId: string;
  roomName: string;
  location: string;
  capacity: number;
  startsAt: Date;
  endsAt: Date;
  originalStartsAt: Date;
  status: 'SCHEDULED' | 'RESCHEDULED' | 'CANCELLED';
  cancelReason: 'HOLIDAY' | 'TEACHER' | null;
  absent: boolean;
}

// The weekly calendar of the student (spec 021): every session of the modules where they are enrolled in the
// period shown, in any state, also the ones they skipped (`absent`). Read only; the student is the token's user.
@Injectable()
export class StudentCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly periods: PeriodsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async calendar(studentId: string, query: StudentCalendarQueryDto) {
    const { from, to } = parseCalendarRange(query.from, query.to);
    const { period, meta } = await calendarMeta(this.prisma, this.periods, this.config, query);
    if (!period) return { data: [], meta: { ...meta, hasEnrollments: false } };
    const start = bogotaToUtc(from, 0);
    const end = bogotaToUtc(new Date(to.getTime() + DAY_MS), 0);
    const [rows, enrolled] = await Promise.all([
      this.prisma.$queryRaw<Row[]>`
        SELECT s.id, s.module_id AS "moduleId", m.name AS "moduleName",
          NULLIF(TRIM(CONCAT(tp.first_name, ' ', tp.last_name)), '') AS "teacherName",
          r.id AS "roomId", r.name AS "roomName", l.name AS location, r.capacity::int AS capacity,
          s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.original_starts_at AS "originalStartsAt",
          s.status::text AS status, s.cancel_reason::text AS "cancelReason",
          EXISTS (
            SELECT 1 FROM session_absences a JOIN enrollments e ON e.id = a.enrollment_id
            WHERE e.student_id = ${studentId}::uuid AND a.session_id = s.id AND a.deleted_at IS NULL
          ) AS absent
        FROM module_sessions s
        JOIN modules m ON m.id = s.module_id AND m.deleted_at IS NULL AND m.period_id = ${period.id}::uuid
        JOIN rooms r ON r.id = s.room_id
        JOIN locations l ON l.id = r.location_id
        LEFT JOIN teacher_profiles tp ON tp.user_id = s.teacher_id
        WHERE s.deleted_at IS NULL AND s.starts_at >= ${start} AND s.starts_at < ${end}
          AND EXISTS (
            SELECT 1 FROM enrollments e
            WHERE e.module_id = s.module_id AND e.student_id = ${studentId}::uuid AND ${ENROLLED_IN_SESSION}
          )
        ORDER BY s.starts_at, s.id`,
      this.prisma.enrollment.count({
        where: { studentId, deletedAt: null, module: { deletedAt: null, periodId: period.id } },
        take: 1,
      }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        moduleId: row.moduleId,
        moduleName: row.moduleName,
        teacherName: row.teacherName ?? '',
        room: { id: row.roomId, name: row.roomName, location: row.location, capacity: row.capacity },
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        originalStartsAt: row.originalStartsAt,
        status: row.status,
        cancelReason: row.cancelReason,
        absent: row.absent,
      })),
      meta: { ...meta, hasEnrollments: enrolled > 0 },
    };
  }
}
