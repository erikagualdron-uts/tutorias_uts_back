import { Injectable } from '@nestjs/common';
import type { AcademicPeriod, Prisma } from '@prisma/client';
import { bogotaCalendarDay, Clock } from '../common/clock.js';
import { violatedConstraint } from '../common/db-errors.js';
import { AppException } from '../common/errors/app.exception.js';
import { ConfigUsageService } from '../config-usage/config-usage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreatePeriodDto,
  ListPeriodsQuery,
  UpdatePeriodDto,
} from './dto/period.dto.js';
import {
  endsAfterStart,
  formatCalendarDay,
  hasEnded,
  parseCalendarDay,
} from './periods.rules.js';

const CONSTRAINTS = [
  'academic_periods_name_unique_idx',
  'academic_periods_no_overlap',
  'academic_periods_single_active_idx',
] as const;

export interface PeriodView {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: AcademicPeriod['status'];
  closedAt: string | null;
  closedBy: AcademicPeriod['closedBy'];
  hasModules: boolean;
}

@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly usage: ConfigUsageService,
  ) {}

  async list(query: ListPeriodsQuery) {
    await this.closeExpired();
    const where: Prisma.AcademicPeriodWhereInput = {
      deletedAt: null,
      ...(query.status && { status: query.status }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.academicPeriod.findMany({
        where,
        orderBy: { startsOn: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.academicPeriod.count({ where }),
    ]);
    const data = await Promise.all(rows.map((row) => this.toView(row)));
    return { data, meta: { page: query.page, limit: query.limit, total } };
  }

  async get(id: string): Promise<PeriodView> {
    await this.closeExpired();
    return this.toView(await this.findOrFail(id));
  }

  async getActive(): Promise<PeriodView> {
    await this.closeExpired();
    const active = await this.prisma.academicPeriod.findFirst({
      where: { status: 'ACTIVE', deletedAt: null },
    });
    if (!active) {
      throw new AppException(404, 'PERIOD_NOT_ACTIVE', 'There is no active period');
    }
    return this.toView(active);
  }

  async create(dto: CreatePeriodDto): Promise<PeriodView> {
    const { startsOn, endsOn } = this.parseDates(dto.startsOn, dto.endsOn);
    await this.assertNameFree(dto.name);
    await this.assertNoOverlap(startsOn, endsOn);
    try {
      const created = await this.prisma.academicPeriod.create({
        data: { name: dto.name, startsOn, endsOn },
      });
      return this.toView(created);
    } catch (error) {
      throw this.translate(error);
    }
  }

  async update(id: string, dto: UpdatePeriodDto): Promise<PeriodView> {
    const current = await this.findOrFail(id);
    // FR-013: a closed period is read-only
    if (current.status === 'CLOSED') {
      throw new AppException(409, 'PERIOD_CLOSED_READ_ONLY', 'A closed period cannot be edited');
    }
    const { startsOn, endsOn } = this.parseDates(
      dto.startsOn ?? formatCalendarDay(current.startsOn),
      dto.endsOn ?? formatCalendarDay(current.endsOn),
    );
    // An active period cannot be shortened to end before today (Bogota calendar day)
    if (
      current.status === 'ACTIVE' &&
      endsOn.getTime() < bogotaCalendarDay(this.clock.now()).getTime()
    ) {
      throw new AppException(422, 'PERIOD_DATES_INVALID', 'An active period cannot end before today');
    }
    const name = dto.name ?? current.name;
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      await this.assertNameFree(name, id);
    }
    await this.assertNoOverlap(startsOn, endsOn, id);
    try {
      const updated = await this.prisma.academicPeriod.update({
        where: { id },
        data: { name, startsOn, endsOn },
      });
      return this.toView(updated);
    } catch (error) {
      throw this.translate(error);
    }
  }

  // D-071: activation is manual; with another active period it needs explicit confirmation.
  async activate(id: string, confirmCloseActive = false): Promise<PeriodView> {
    await this.closeExpired();
    try {
      const activated = await this.prisma.$transaction(async (tx) => {
        // Lock the current active row so concurrent activations queue up behind each other.
        await tx.$queryRaw`SELECT id FROM academic_periods WHERE status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE`;
        const target = await tx.academicPeriod.findFirst({
          where: { id, deletedAt: null },
        });
        if (!target) throw new AppException(404, 'NOT_FOUND', 'Period not found');
        if (target.status !== 'UPCOMING') {
          throw new AppException(409, 'PERIOD_NOT_UPCOMING', 'Only an upcoming period can be activated');
        }
        const now = this.clock.now();
        if (hasEnded(target.endsOn, now)) {
          throw new AppException(409, 'PERIOD_ALREADY_ENDED', 'The period end date has already passed');
        }
        const current = await tx.academicPeriod.findFirst({
          where: { status: 'ACTIVE', deletedAt: null },
        });
        if (current) {
          if (!confirmCloseActive) {
            throw new AppException(409, 'PERIOD_ACTIVE_EXISTS', 'Another period is active', {
              activePeriod: { id: current.id, name: current.name },
            });
          }
          await tx.academicPeriod.update({
            where: { id: current.id },
            data: { status: 'CLOSED', closedAt: now, closedBy: 'MANUAL' },
          });
        }
        return tx.academicPeriod.update({ where: { id }, data: { status: 'ACTIVE' } });
      });
      return this.toView(activated);
    } catch (error) {
      if (error instanceof AppException) throw error;
      // Two activations raced: the unique index let only one through.
      throw this.translate(error);
    }
  }

  async close(id: string): Promise<PeriodView> {
    const period = await this.findOrFail(id);
    if (period.status !== 'ACTIVE') {
      throw new AppException(409, 'PERIOD_NOT_ACTIVE', 'Only the active period can be closed');
    }
    const closed = await this.prisma.academicPeriod.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: this.clock.now(), closedBy: 'MANUAL' },
    });
    return this.toView(closed);
  }

  // FR-014 (D-076): only an upcoming period without modules is deleted, and logically.
  async remove(id: string): Promise<void> {
    const period = await this.findOrFail(id);
    if (period.status !== 'UPCOMING') {
      throw new AppException(409, 'PERIOD_NOT_UPCOMING', 'Only an upcoming period can be deleted');
    }
    if ((await this.usage.countModulesInPeriod(id)) > 0) {
      throw new AppException(409, 'PERIOD_HAS_MODULES', 'The period has modules');
    }
    await this.prisma.academicPeriod.update({
      where: { id },
      data: { deletedAt: this.clock.now() },
    });
  }

  // Idempotent: closes the active period once its last day has ended in Bogota.
  async closeExpired(): Promise<number> {
    const now = this.clock.now();
    const active = await this.prisma.academicPeriod.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
    });
    let closed = 0;
    for (const period of active) {
      if (!hasEnded(period.endsOn, now)) continue;
      const result = await this.prisma.academicPeriod.updateMany({
        where: { id: period.id, status: 'ACTIVE' },
        data: { status: 'CLOSED', closedAt: now, closedBy: 'AUTOMATIC' },
      });
      closed += result.count;
    }
    return closed;
  }

  private parseDates(startsOn: string, endsOn: string) {
    const start = parseCalendarDay(startsOn);
    const end = parseCalendarDay(endsOn);
    if (!start || !end || !endsAfterStart(start, end)) {
      throw new AppException(422, 'PERIOD_DATES_INVALID', 'The end date must be after the start date');
    }
    return { startsOn: start, endsOn: end };
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const taken = await this.prisma.academicPeriod.findFirst({
      where: {
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId && { id: { not: exceptId } }),
      },
    });
    if (taken) {
      throw new AppException(409, 'PERIOD_NAME_TAKEN', 'A period with that name already exists');
    }
  }

  // Closed range: a period ending the day another starts counts as overlapping (FR-009).
  private async assertNoOverlap(startsOn: Date, endsOn: Date, exceptId?: string) {
    const clash = await this.prisma.academicPeriod.findFirst({
      where: {
        deletedAt: null,
        startsOn: { lte: endsOn },
        endsOn: { gte: startsOn },
        ...(exceptId && { id: { not: exceptId } }),
      },
    });
    if (clash) {
      throw new AppException(409, 'PERIOD_DATES_OVERLAP', 'The dates overlap with another period', {
        overlappingPeriod: {
          id: clash.id,
          name: clash.name,
          startsOn: formatCalendarDay(clash.startsOn),
          endsOn: formatCalendarDay(clash.endsOn),
        },
      });
    }
  }

  private async findOrFail(id: string) {
    const period = await this.prisma.academicPeriod.findFirst({
      where: { id, deletedAt: null },
    });
    if (!period) throw new AppException(404, 'NOT_FOUND', 'Period not found');
    return period;
  }

  // Safety net for races the pre-checks cannot see: the database constraints have the last word.
  private translate(error: unknown): unknown {
    switch (violatedConstraint(error, CONSTRAINTS)) {
      case 'academic_periods_name_unique_idx':
        return new AppException(409, 'PERIOD_NAME_TAKEN', 'A period with that name already exists');
      case 'academic_periods_no_overlap':
        return new AppException(409, 'PERIOD_DATES_OVERLAP', 'The dates overlap with another period');
      case 'academic_periods_single_active_idx':
        return new AppException(409, 'PERIOD_ACTIVE_EXISTS', 'Another period is active');
      default:
        return error;
    }
  }

  private async toView(period: AcademicPeriod): Promise<PeriodView> {
    return {
      id: period.id,
      name: period.name,
      startsOn: formatCalendarDay(period.startsOn),
      endsOn: formatCalendarDay(period.endsOn),
      status: period.status,
      closedAt: period.closedAt?.toISOString() ?? null,
      closedBy: period.closedBy,
      hasModules: (await this.usage.countModulesInPeriod(period.id)) > 0,
    };
  }
}
