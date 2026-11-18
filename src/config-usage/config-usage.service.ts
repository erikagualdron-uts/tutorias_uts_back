import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RoomUsage {
  modulesInActivePeriod: number;
  modulesInUpcomingPeriods: number;
  maxEnrolled: number;
}

// Answers "is this record used by something else?" for the configuration rules.
// Modules exist since spec 010, so the module counts are real. Enrollments (spec 011) and PQRS
// do not exist yet, so enrolled students count as zero and no dropdown item is in use until
// those features replace these bodies; the rules that call them are already wired and tested.
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
    return { modulesInActivePeriod, modulesInUpcomingPeriods, maxEnrolled: 0 };
  }

  // Active enrollments of a module. Zero until the enrollment feature (spec 011) exists.
  countActiveEnrollments(_moduleId: string): Promise<number> {
    return Promise.resolve(0);
  }

  isDropdownItemInUse(_itemId: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}
