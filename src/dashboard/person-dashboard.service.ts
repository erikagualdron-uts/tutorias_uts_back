import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { ConfigUsageService } from '../config-usage/config-usage.service.js';
import { ATTENDS_SESSION, sessionSeats } from '../enrollments/seats.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { weekRangeBogota } from './dashboard.rules.js';
import { RECENT_CHANGE_INCLUDE, RECENT_CHANGE_ORDER, RECENT_CHANGE_WHERE, changeView } from './recent-changes.js';

const LIVE = ['SCHEDULED', 'RESCHEDULED'] as const;
const RECENT_LIMIT = 5;

export interface StudentSessionRow {
  sessionId: string;
  moduleId: string;
  moduleName: string;
  startsAt: Date;
  endsAt: Date;
  room: string;
}

// Teacher and student summaries (spec 019). Everything is scoped to the signed-in user.
@Injectable()
export class PersonDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly usage: ConfigUsageService,
  ) {}

  async teacher(userId: string) {
    const now = this.clock.now();
    const week = weekRangeBogota(now);
    const mine = { teacherId: userId, deletedAt: null, status: { in: [...LIVE] }, module: { deletedAt: null } } satisfies Prisma.ModuleSessionWhereInput;
    const [next, weekSessions, modules] = await Promise.all([
      this.prisma.moduleSession.findFirst({
        where: { ...mine, startsAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
        include: { module: { select: { id: true, name: true } } },
      }),
      this.prisma.moduleSession.count({ where: { ...mine, startsAt: { gte: week.from, lt: week.to } } }),
      this.prisma.module.findMany({
        where: { teacherId: userId, deletedAt: null, period: { status: 'ACTIVE', deletedAt: null } },
        include: { room: { select: { capacity: true } } },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const [room, seats, enrolled] = await Promise.all([
      next ? this.prisma.room.findUnique({ where: { id: next.roomId }, select: { name: true } }) : null,
      next ? sessionSeats(this.prisma, [next.moduleId], now, { from: next.startsAt, to: new Date(next.startsAt.getTime() + 1) }) : [],
      Promise.all(modules.map((m) => this.usage.countActiveEnrollments(m.id))),
    ]);
    return {
      nextSession: next && {
        sessionId: next.id,
        moduleId: next.module.id,
        moduleName: next.module.name,
        startsAt: next.startsAt,
        endsAt: next.endsAt,
        room: room?.name ?? '',
        attendees: seats[0]?.attendees ?? 0,
      },
      weekSessions,
      modules: modules.map((m, i) => ({ id: m.id, name: m.name, enrolled: enrolled[i], capacity: m.room.capacity })),
    };
  }

  // The sessions the student attends follow `ATTENDS_SESSION` (skipped sessions, cancelled enrollments).
  async student(userId: string) {
    const now = this.clock.now();
    const week = weekRangeBogota(now);
    const attended = Prisma.sql`FROM module_sessions s
      JOIN modules m ON m.id = s.module_id AND m.deleted_at IS NULL
      JOIN rooms r ON r.id = s.room_id
      JOIN enrollments e ON e.module_id = s.module_id AND e.student_id = ${userId}::uuid
      WHERE s.deleted_at IS NULL AND s.status IN ('SCHEDULED', 'RESCHEDULED') AND ${ATTENDS_SESSION}`;
    const [next, count, changes] = await Promise.all([
      this.prisma.$queryRaw<StudentSessionRow[]>`
        SELECT s.id AS "sessionId", s.module_id AS "moduleId", m.name AS "moduleName", s.starts_at AS "startsAt",
          s.ends_at AS "endsAt", r.name AS room
        ${attended} AND s.starts_at > ${now} ORDER BY s.starts_at LIMIT 1`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT COUNT(DISTINCT s.id)::int AS total ${attended} AND s.starts_at >= ${week.from} AND s.starts_at < ${week.to}`,
      this.prisma.moduleSession.findMany({
        where: {
          ...RECENT_CHANGE_WHERE,
          module: { ...RECENT_CHANGE_WHERE.module, enrollments: { some: { studentId: userId, status: 'ACTIVE', deletedAt: null } } },
        },
        include: RECENT_CHANGE_INCLUDE,
        orderBy: RECENT_CHANGE_ORDER,
        take: RECENT_LIMIT,
      }),
    ]);
    return { nextSession: next[0] ?? null, weekSessions: count[0]?.total ?? 0, changes: changes.map(changeView) };
  }
}
