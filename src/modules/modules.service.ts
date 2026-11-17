import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { bogotaCalendarDay, Clock } from '../common/clock.js';
import { AppException } from '../common/errors/app.exception.js';
import { ConfigUsageService } from '../config-usage/config-usage.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PeriodsService } from '../periods/periods.service.js';
import { parseCalendarDay } from '../periods/periods.rules.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ChangeRoomDto,
  CreateModuleDto,
  ListModulesQuery,
  ListSessionsQuery,
} from './dto/module.dto.js';
import { SchedulesService } from './schedules.service.js';
import { SessionsGenerator } from './sessions.generator.js';
import { bogotaToUtc, dayKey, formatTime, isoWeekday } from './sessions.rules.js';

const DAY_MS = 86_400_000;

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

export interface ModuleDetailView extends ReturnType<typeof summary> {
  description: string | null;
  holidayDates: string[];
  canChangeSchedules: boolean;
  canDelete: boolean;
  readOnlyReason: 'PERIOD_CLOSED' | null;
}

const MODULE_INCLUDE = {
  period: true,
  teacher: { include: { teacherProfile: true } },
  room: { include: { location: true } },
  schedules: { where: { deletedAt: null }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
} satisfies Prisma.ModuleInclude;

type ModuleRow = Prisma.ModuleGetPayload<{ include: typeof MODULE_INCLUDE }>;
type UserWithProfile = Prisma.UserGetPayload<{ include: { teacherProfile: true } }>;
type RoomWithLocation = Prisma.RoomGetPayload<{ include: { location: true } }>;

const personRef = (user: UserWithProfile): PersonRef => ({
  id: user.id,
  firstName: user.teacherProfile?.firstName ?? '',
  lastName: user.teacherProfile?.lastName ?? '',
});

const roomRef = (room: RoomWithLocation): RoomRef => ({
  id: room.id,
  name: room.name,
  locationName: room.location.name,
  capacity: room.capacity,
});

// What the list and the detail share. `generated` adds how many sessions each slot just created.
function summary(module: ModuleRow, enrolled: number, generated?: ReadonlyMap<string, number>) {
  return {
    id: module.id,
    periodId: module.periodId,
    periodStatus: module.period.status,
    name: module.name,
    teacher: personRef(module.teacher),
    room: roomRef(module.room),
    capacity: module.room.capacity,
    enrolled,
    schedules: module.schedules.map((s) => ({
      id: s.id,
      dayOfWeek: s.dayOfWeek,
      startTime: formatTime(s.startMinute),
      endTime: formatTime(s.endMinute),
      ...(generated && { sessionsGenerated: generated.get(s.id) ?? 0 }),
    })),
    roomUnavailable: module.room.status !== 'ACTIVE' || module.room.deletedAt !== null,
    teacherUnavailable:
      module.teacher.role !== 'TEACHER' ||
      module.teacher.status !== 'ACTIVE' ||
      module.teacher.deletedAt !== null,
  };
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
    private readonly outbox: OutboxService,
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

  // FR-016: modules of one period (the active one, else the nearest upcoming one by default).
  async list(query: ListModulesQuery) {
    await this.periods.closeExpired();
    const periodId = query.periodId ?? (await this.defaultPeriodId());
    const meta = { page: query.page, limit: query.limit, periodId: periodId ?? null };
    if (!periodId) return { data: [], meta: { ...meta, total: 0 } };
    const where: Prisma.ModuleWhereInput = {
      periodId,
      deletedAt: null,
      ...(query.search && { name: { contains: query.search, mode: 'insensitive' } }),
      ...(query.teacherId && { teacherId: query.teacherId }),
      ...(query.roomId && { roomId: query.roomId }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.module.findMany({
        where,
        include: MODULE_INCLUDE,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.module.count({ where }),
    ]);
    const data = await Promise.all(
      rows.map(async (row) => summary(row, await this.usage.countActiveEnrollments(row.id))),
    );
    return { data, meta: { ...meta, total } };
  }

  // FR-017: sessions by start, optionally between two Bogota calendar days (both inclusive).
  async listSessions(id: string, query: ListSessionsQuery) {
    await this.findLive(id);
    const day = (value?: string) => {
      if (value === undefined) return undefined;
      const parsed = parseCalendarDay(value);
      if (!parsed) throw new AppException(400, 'VALIDATION_FAILED', 'Not a calendar day');
      return parsed;
    };
    const from = day(query.from);
    const to = day(query.to);
    const where: Prisma.ModuleSessionWhereInput = {
      moduleId: id,
      deletedAt: null,
      startsAt: {
        ...(from && { gte: bogotaToUtc(from, 0) }),
        ...(to && { lt: bogotaToUtc(new Date(to.getTime() + DAY_MS), 0) }),
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.moduleSession.findMany({
        where,
        orderBy: { startsAt: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.moduleSession.count({ where }),
    ]);
    const [teachers, rooms] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.teacherId))] } },
        include: { teacherProfile: true },
      }),
      this.prisma.room.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.roomId))] } },
        include: { location: true },
      }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        originalStartsAt: row.originalStartsAt.toISOString(),
        status: row.status,
        cancelReason: row.cancelReason,
        teacher: personRef(teachers.find((t) => t.id === row.teacherId)!),
        room: roomRef(rooms.find((r) => r.id === row.roomId)!),
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  // FR-010: the new room must be free at the slots and hold at least the enrolled students; future
  // sessions follow it and past ones keep the room they were given in.
  async changeRoom(id: string, dto: ChangeRoomDto): Promise<ModuleDetailView> {
    await this.periods.closeExpired();
    const current = await this.findLive(id);
    const availability = {
      teacherId: current.teacherId,
      roomId: dto.roomId,
      periodId: current.periodId,
      slots: current.schedules,
      ignoreModuleId: id,
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockWritablePeriod(tx, current.periodId);
        await tx.$queryRaw`SELECT id FROM modules WHERE id = ${id}::uuid FOR UPDATE`;
        const module = await tx.module.findFirst({ where: { id, deletedAt: null } });
        if (!module) throw new AppException(404, 'NOT_FOUND', 'Module not found');
        if (module.roomId === dto.roomId) return;
        await this.assertRoom(tx, dto.roomId);
        const room = await tx.room.findUniqueOrThrow({ where: { id: dto.roomId } });
        const enrolled = await this.usage.countActiveEnrollments(id);
        if (room.capacity < enrolled) {
          throw new AppException(409, 'MODULE_ROOM_CAPACITY_BELOW_ENROLLED', 'The room is too small', {
            capacity: room.capacity,
            enrolled,
          });
        }
        const conflict = await this.schedules.findConflict(tx, { kind: 'room', id: dto.roomId, ...availability });
        if (conflict) {
          throw new AppException(409, 'MODULE_ROOM_CONFLICT', 'The room is taken at that time', { conflict });
        }
        const live = { moduleId: id, deletedAt: null };
        await tx.module.update({ where: { id }, data: { roomId: dto.roomId } });
        await tx.moduleSchedule.updateMany({ where: live, data: { roomId: dto.roomId } });
        await tx.moduleSession.updateMany({
          where: { ...live, startsAt: { gt: this.clock.now() } },
          data: { roomId: dto.roomId },
        });
        await this.outbox.record(tx, {
          type: 'MODULE_ROOM_CHANGED',
          moduleId: id,
          payload: { fromRoomId: module.roomId, toRoomId: dto.roomId, enrolled },
        });
      });
    } catch (error) {
      throw await this.schedules.translate(error, availability);
    }
    return this.detail(id);
  }

  async detail(id: string, generated?: ReadonlyMap<string, number>): Promise<ModuleDetailView> {
    const module = await this.findLive(id);
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
    return {
      ...summary(module, enrolled, generated),
      description: module.description,
      holidayDates: holidays.filter((h) => days.has(isoWeekday(h.date))).map((h) => dayKey(h.date)),
      canChangeSchedules: !closed && enrolled === 0,
      canDelete: !closed && enrolled === 0,
      readOnlyReason: closed ? 'PERIOD_CLOSED' : null,
    };
  }

  private async findLive(id: string) {
    const module = await this.prisma.module.findFirst({ where: { id, deletedAt: null }, include: MODULE_INCLUDE });
    if (!module) throw new AppException(404, 'NOT_FOUND', 'Module not found');
    return module;
  }

  private async defaultPeriodId(): Promise<string | undefined> {
    const period =
      (await this.prisma.academicPeriod.findFirst({ where: { status: 'ACTIVE', deletedAt: null } })) ??
      (await this.prisma.academicPeriod.findFirst({
        where: { status: 'UPCOMING', deletedAt: null },
        orderBy: { startsOn: 'asc' },
      }));
    return period?.id;
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
