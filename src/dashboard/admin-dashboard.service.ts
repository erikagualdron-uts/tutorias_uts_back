import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { classifyModule, occupancyPercent, rankRooms, type RoomLoad } from './dashboard.rules.js';
import { RECENT_CHANGE_INCLUDE, RECENT_CHANGE_ORDER, RECENT_CHANGE_WHERE, changeView } from './recent-changes.js';

interface ModuleLoadRow {
  roomId: string;
  roomName: string;
  location: string;
  capacity: number;
  enrolled: number;
}

@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // One row per live module of the ACTIVE period; enrolled counts ACTIVE enrollments of active accounts,
  // the same as `countActiveEnrollments` (spec 011).
  private moduleLoads() {
    return this.prisma.$queryRaw<ModuleLoadRow[]>`
      SELECT r.id AS "roomId", r.name AS "roomName", l.name AS location, r.capacity::int AS capacity,
        (
          SELECT COUNT(*)::int FROM enrollments e
          JOIN users u ON u.id = e.student_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
          WHERE e.module_id = m.id AND e.status = 'ACTIVE' AND e.deleted_at IS NULL
        ) AS enrolled
      FROM modules m
      JOIN academic_periods p ON p.id = m.period_id AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
      JOIN rooms r ON r.id = m.room_id
      JOIN locations l ON l.id = r.location_id
      WHERE m.deleted_at IS NULL`;
  }

  async overview() {
    const [loads, lowEnrollmentPercent, roles, byStatus, avg] = await Promise.all([
      this.moduleLoads(),
      this.settings.get('dashboard.lowEnrollmentPercent'),
      this.prisma.user.groupBy({
        by: ['role'],
        where: { role: { in: ['STUDENT', 'TEACHER'] }, status: 'ACTIVE', deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.pqrs.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.$queryRaw<{ seconds: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)))::float AS seconds
        FROM pqrs WHERE status = 'RESOLVED' AND resolved_at IS NOT NULL AND deleted_at IS NULL`,
    ]);
    const enrolled = loads.reduce((sum, m) => sum + m.enrolled, 0);
    const capacity = loads.reduce((sum, m) => sum + m.capacity, 0);
    const kinds = loads.map((m) => classifyModule(m.enrolled, m.capacity, lowEnrollmentPercent));
    const accounts = (role: 'STUDENT' | 'TEACHER') => roles.find((r) => r.role === role)?._count._all ?? 0;
    const pqrs = (status: string) => byStatus.find((r) => r.status === status)?._count._all ?? 0;
    const seconds = avg[0]?.seconds;
    return {
      occupancy: { enrolled, capacity, percent: occupancyPercent(enrolled, capacity) },
      modules: { active: loads.length, full: kinds.filter((k) => k === 'full').length, lowEnrollment: kinds.filter((k) => k === 'low').length },
      lowEnrollmentPercent,
      accounts: { students: accounts('STUDENT'), teachers: accounts('TEACHER') },
      pqrs: {
        filed: pqrs('FILED'),
        inReview: pqrs('IN_REVIEW'),
        resolved: pqrs('RESOLVED'),
        avgResponseSeconds: seconds == null ? null : Math.round(seconds),
      },
    };
  }

  async changes(page: number, limit: number) {
    const [rows, total] = await Promise.all([
      this.prisma.moduleSession.findMany({
        where: RECENT_CHANGE_WHERE,
        include: RECENT_CHANGE_INCLUDE,
        orderBy: RECENT_CHANGE_ORDER,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.moduleSession.count({ where: RECENT_CHANGE_WHERE }),
    ]);
    return { data: rows.map(changeView), meta: { page, limit, total } };
  }

  async rooms() {
    const byRoom = new Map<string, { name: string; location: string; capacity: number; enrolled: number; modules: number }>();
    for (const m of await this.moduleLoads()) {
      const room = byRoom.get(m.roomId) ?? { name: m.roomName, location: m.location, capacity: 0, enrolled: 0, modules: 0 };
      byRoom.set(m.roomId, { ...room, capacity: room.capacity + m.capacity, enrolled: room.enrolled + m.enrolled, modules: room.modules + 1 });
    }
    // A room's occupancy is the average of its modules', i.e. enrolled over the summed capacities.
    const loads: RoomLoad[] = [...byRoom].map(([roomId, r]) => ({
      roomId,
      name: r.name,
      location: r.location,
      percent: occupancyPercent(r.enrolled, r.capacity),
      modules: r.modules,
    }));
    return rankRooms(loads);
  }
}
