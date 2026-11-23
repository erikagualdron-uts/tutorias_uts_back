import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RoomUsage {
  modulesInActivePeriod: number;
  modulesInUpcomingPeriods: number;
  maxEnrolled: number;
}

// Answers "is this record used by something else?" for the configuration rules.
// Modules (spec 010), enrollments (spec 011) and PQRS (spec 017) are real rows.
@Injectable()
export class ConfigUsageService {
  constructor(private readonly prisma: PrismaService) {}

  countModulesInPeriod(periodId: string): Promise<number> {
    return this.prisma.module.count({ where: { periodId, deletedAt: null } });
  }

  async getRoomUsage(roomId: string): Promise<RoomUsage> {
    const countIn = (status: 'ACTIVE' | 'UPCOMING') =>
      this.prisma.module.count({
        where: { roomId, deletedAt: null, period: { status, deletedAt: null } },
      });
    const [modulesInActivePeriod, modulesInUpcomingPeriods] = await Promise.all([
      countIn('ACTIVE'),
      countIn('UPCOMING'),
    ]);
    return { modulesInActivePeriod, modulesInUpcomingPeriods, maxEnrolled: await this.maxEnrolled(roomId) };
  }

  // Largest number of active enrollments among the live modules of a room in a period not closed.
  private async maxEnrolled(roomId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ max: bigint | null }[]>`
      SELECT MAX(total) AS max FROM (
        SELECT COUNT(*) AS total
        FROM modules m
        JOIN academic_periods p ON p.id = m.period_id AND p.status <> 'CLOSED' AND p.deleted_at IS NULL
        JOIN enrollments e ON e.module_id = m.id AND e.status = 'ACTIVE' AND e.deleted_at IS NULL
        JOIN users u ON u.id = e.student_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
        WHERE m.room_id = ${roomId}::uuid AND m.deleted_at IS NULL
        GROUP BY m.id
      ) per_module`;
    return Number(rows[0]?.max ?? 0);
  }

  // Active enrollments of a module whose student account is active and not deleted (FR-015).
  countActiveEnrollments(moduleId: string): Promise<number> {
    return this.prisma.enrollment.count({
      where: { moduleId, status: 'ACTIVE', deletedAt: null, student: { status: 'ACTIVE', deletedAt: null } },
    });
  }

  // An item is in use as soon as one PQRS was filed with it, also a deleted one: the history keeps its type.
  async isDropdownItemInUse(itemId: string): Promise<boolean> {
    return (await this.prisma.pqrs.count({ where: { typeId: itemId } })) > 0;
  }
}
