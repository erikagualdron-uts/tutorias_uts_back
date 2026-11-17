import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { bogotaCalendarDay, Clock } from '../common/clock.js';
import { AppException } from '../common/errors/app.exception.js';
import { ConfigUsageService } from '../config-usage/config-usage.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateModuleDto } from './dto/module.dto.js';
import { SchedulesService } from './schedules.service.js';
import { SessionsGenerator } from './sessions.generator.js';
import { dayKey, formatTime, isoWeekday } from './sessions.rules.js';

export interface PersonRef {
  id: string;
  firstName: string;
  lastName: string;
}

export interface RoomRef {
  id: string;
  name: string;
  locationName: string;
  capacity: number;
}

export interface ScheduleView {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  sessionsGenerated?: number;
}

export interface ModuleDetailView {
  id: string;
  periodId: string;
  periodStatus: 'UPCOMING' | 'ACTIVE' | 'CLOSED';
  name: string;
  description: string | null;
  teacher: PersonRef;
  room: RoomRef;
  capacity: number;
  enrolled: number;
  schedules: ScheduleView[];
  holidayDates: string[];
  canChangeSchedules: boolean;
  canDelete: boolean;
  readOnlyReason: 'PERIOD_CLOSED' | null;
  roomUnavailable: boolean;
  teacherUnavailable: boolean;
}

@Injectable()
export class ModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly usage: ConfigUsageService,
    private readonly periods: PeriodsService,
    private readonly schedules: SchedulesService,
    private readonly generator: SessionsGenerator,
  ) {}

  // FR-001 to FR-009: a module with its weekly slots and one session per week of the period.
  async create(dto: CreateModuleDto): Promise<ModuleDetailView> {
    const slots = this.schedules.parse(dto.schedules);
    const availability = {
      teacherId: dto.teacherId,
      roomId: dto.roomId,
      periodId: dto.periodId,
      slots,
    };
    // A period whose last day has passed is closed before anything else is decided.
    await this.periods.closeExpired();
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const period = await this.lockWritablePeriod(tx, dto.periodId);
        await this.assertTeacher(tx, dto.teacherId);
        await this.assertRoom(tx, dto.roomId);
        await this.schedules.assertFree(tx, availability);
        const module = await tx.module.create({
          data: {
            periodId: period.id,
            name: dto.name,
            description: dto.description || null,
            teacherId: dto.teacherId,
            roomId: dto.roomId,
          },
        });
        const rows = [];
        for (const slot of slots) {
          rows.push(
            await tx.moduleSchedule.create({
              data: {
                moduleId: module.id,
                periodId: period.id,
                teacherId: dto.teacherId,
                roomId: dto.roomId,
                ...slot,
              },
            }),
          );
        }
        const generated = await this.generator.generate(tx, {
          moduleId: module.id,
          teacherId: dto.teacherId,
          roomId: dto.roomId,
          startsOn: period.startsOn,
          endsOn: period.endsOn,
          schedules: rows,
        });
        return { id: module.id, generated };
      });
      return await this.detail(created.id, created.generated);
    } catch (error) {
      throw await this.schedules.translate(error, availability);
    }
  }

  // Builds the detail of a live module. `generated` adds how many sessions each slot just created.
  async detail(id: string, generated?: ReadonlyMap<string, number>): Promise<ModuleDetailView> {
    const module = await this.prisma.module.findFirst({
      where: { id, deletedAt: null },
      include: {
        period: true,
        teacher: { include: { teacherProfile: true } },
        room: { include: { location: true } },
        schedules: {
          where: { deletedAt: null },
          orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
        },
      },
    });
    if (!module) throw new AppException(404, 'NOT_FOUND', 'Module not found');

    const enrolled = await this.usage.countActiveEnrollments(id);
    const closed = module.period.status === 'CLOSED';
    const today = bogotaCalendarDay(this.clock.now());
    const from = today.getTime() > module.period.startsOn.getTime() ? today : module.period.startsOn;
    const days = new Set(module.schedules.map((s) => s.dayOfWeek));
    const holidays = await this.prisma.holiday.findMany({
      where: { deletedAt: null, date: { gte: from, lte: module.period.endsOn } },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    const profile = module.teacher.teacherProfile;

    return {
      id: module.id,
      periodId: module.periodId,
      periodStatus: module.period.status,
      name: module.name,
      description: module.description,
      teacher: {
        id: module.teacher.id,
        firstName: profile?.firstName ?? '',
        lastName: profile?.lastName ?? '',
      },
      room: {
        id: module.room.id,
        name: module.room.name,
        locationName: module.room.location.name,
        capacity: module.room.capacity,
      },
      capacity: module.room.capacity,
      enrolled,
      schedules: module.schedules.map((s) => ({
        id: s.id,
        dayOfWeek: s.dayOfWeek,
        startTime: formatTime(s.startMinute),
        endTime: formatTime(s.endMinute),
        ...(generated && { sessionsGenerated: generated.get(s.id) ?? 0 }),
      })),
      holidayDates: holidays.filter((h) => days.has(isoWeekday(h.date))).map((h) => dayKey(h.date)),
      canChangeSchedules: !closed && enrolled === 0,
      canDelete: !closed && enrolled === 0,
      readOnlyReason: closed ? 'PERIOD_CLOSED' : null,
      roomUnavailable: module.room.status !== 'ACTIVE' || module.room.deletedAt !== null,
      teacherUnavailable:
        module.teacher.role !== 'TEACHER' ||
        module.teacher.status !== 'ACTIVE' ||
        module.teacher.deletedAt !== null,
    };
  }

  // Shared lock on the period row (research.md R-2): a close that arrives meanwhile waits for this
  // transaction, and one that already happened is seen here as CLOSED.
  private async lockWritablePeriod(tx: Prisma.TransactionClient, periodId: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM academic_periods WHERE id = ${periodId}::uuid AND deleted_at IS NULL FOR SHARE`;
    if (locked.length === 0) throw new AppException(404, 'NOT_FOUND', 'Period not found');
    const period = await tx.academicPeriod.findUniqueOrThrow({ where: { id: periodId } });
    if (period.status === 'CLOSED') {
      throw new AppException(409, 'PERIOD_CLOSED_READ_ONLY', 'A closed period is read-only');
    }
    return period;
  }

  private async assertTeacher(tx: Prisma.TransactionClient, teacherId: string) {
    const user = await tx.user.findUnique({ where: { id: teacherId } });
    if (!user) throw new AppException(404, 'NOT_FOUND', 'Teacher not found');
    if (user.role !== 'TEACHER' || user.status !== 'ACTIVE' || user.deletedAt) {
      throw new AppException(409, 'MODULE_TEACHER_UNAVAILABLE', 'Only an active teacher can be assigned');
    }
  }

  private async assertRoom(tx: Prisma.TransactionClient, roomId: string) {
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (!room) throw new AppException(404, 'NOT_FOUND', 'Room not found');
    if (room.status !== 'ACTIVE' || room.deletedAt) {
      throw new AppException(409, 'MODULE_ROOM_UNAVAILABLE', 'Only an active room can be assigned');
    }
  }
}
