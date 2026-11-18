import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Env } from '../config/env.js';
import { ConfigUsageService } from '../config-usage/config-usage.service.js';
import { sessionSeats } from '../enrollments/seats.js';
import { bogotaToUtc, formatTime } from '../modules/sessions.rules.js';
import { formatCalendarDay, parseCalendarDay } from '../periods/periods.rules.js';
import { PeriodsService } from '../periods/periods.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseCalendarRange, pickCalendarPeriod } from './calendar.rules.js';
import type {
  TeacherCalendarQueryDto,
  TeacherModulesQueryDto,
  TeacherSessionsQueryDto,
} from './dto/teacher-sessions.dto.js';
import { sessionChangeActions } from './teacher-sessions.rules.js';

const DAY_MS = 86_400_000;

const SESSION_INCLUDE = {
  module: { select: { name: true, period: { select: { status: true } } } },
} satisfies Prisma.ModuleSessionInclude;

type SessionRow = Prisma.ModuleSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

// Modules and sessions of the teacher in the shape of the contract. Everything is loaded in bulk.
@Injectable()
export class TeacherScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
    private readonly periods: PeriodsService,
    private readonly usage: ConfigUsageService,
  ) {}

  get leadMinutes(): number {
    return this.config.get('TEACHER_CHANGE_LEAD_MINUTES', { infer: true });
  }

  async modules(teacherId: string, query: TeacherModulesQueryDto) {
    await this.periods.closeExpired();
    const period = await this.prisma.academicPeriod.findFirst({ where: { status: 'ACTIVE', deletedAt: null } });
    const meta = { page: query.page, limit: query.limit, periodId: period?.id ?? null };
    if (!period) return { data: [], meta: { ...meta, total: 0 } };
    const where: Prisma.ModuleWhereInput = { periodId: period.id, teacherId, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.module.findMany({
        where,
        include: {
          room: { include: { location: true } },
          schedules: { where: { deletedAt: null }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.module.count({ where }),
    ]);
    const now = this.clock.now();
    const next = await this.prisma.moduleSession.findMany({
      where: { moduleId: { in: rows.map((r) => r.id) }, teacherId, deletedAt: null, startsAt: { gt: now } },
      include: SESSION_INCLUDE,
      orderBy: { startsAt: 'asc' },
    });
    const nextViews = await this.views(next, now);
    const first = new Map<string, (typeof nextViews)[number]>();
    for (const view of nextViews) if (!first.has(view.moduleId)) first.set(view.moduleId, view);
    const data = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        room: { id: row.room.id, name: row.room.name, location: row.room.location.name, capacity: row.room.capacity },
        schedules: row.schedules.map((s) => ({
          dayOfWeek: s.dayOfWeek,
          startTime: formatTime(s.startMinute),
          endTime: formatTime(s.endMinute),
        })),
        enrolled: await this.usage.countActiveEnrollments(row.id),
        capacity: row.room.capacity,
        readOnly: false,
        nextSession: first.get(row.id) ?? null,
      })),
    );
    return { data, meta: { ...meta, total } };
  }

  // Future sessions only: a `from` in the past is moved to now.
  async sessions(teacherId: string, query: TeacherSessionsQueryDto) {
    const now = this.clock.now();
    const day = (value?: string) => {
      if (value === undefined) return undefined;
      const parsed = parseCalendarDay(value);
      if (!parsed) throw new AppException(400, 'VALIDATION_FAILED', 'Not a calendar day');
      return parsed;
    };
    const from = day(query.from);
    const to = day(query.to);
    const where: Prisma.ModuleSessionWhereInput = {
      teacherId,
      deletedAt: null,
      module: { deletedAt: null, period: { status: { not: 'UPCOMING' } } },
      ...(query.moduleId && { moduleId: query.moduleId }),
      startsAt: {
        gt: now,
        ...(from && { gte: bogotaToUtc(from, 0) }),
        ...(to && { lt: bogotaToUtc(new Date(to.getTime() + DAY_MS), 0) }),
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.moduleSession.findMany({
        where,
        include: SESSION_INCLUDE,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.moduleSession.count({ where }),
    ]);
    return {
      data: await this.views(rows, now),
      meta: { page: query.page, limit: query.limit, total, changeLeadMinutes: this.leadMinutes },
    };
  }

  // The sessions of the teacher in a range of days (a week for the calendar), past ones included. It shows
  // the active period or, without one, the last closed period read only (spec 013, research R-2).
  async calendar(teacherId: string, query: TeacherCalendarQueryDto) {
    const { from, to } = parseCalendarRange(query.from, query.to);
    await this.periods.closeExpired();
    const [active, closed] = await Promise.all([
      this.prisma.academicPeriod.findFirst({ where: { status: 'ACTIVE', deletedAt: null } }),
      this.prisma.academicPeriod.findFirst({
        where: { status: 'CLOSED', deletedAt: null },
        orderBy: [{ endsOn: 'desc' }, { id: 'asc' }],
      }),
    ]);
    const period = pickCalendarPeriod(active, closed);
    const meta = {
      from: query.from,
      to: query.to,
      period: period && {
        id: period.id,
        name: period.name,
        startsOn: formatCalendarDay(period.startsOn),
        endsOn: formatCalendarDay(period.endsOn),
        status: period.status as 'ACTIVE' | 'CLOSED',
      },
      hours: {
        earliest: formatTime(this.config.get('MODULE_EARLIEST_MINUTE', { infer: true })),
        latest: formatTime(this.config.get('MODULE_LATEST_MINUTE', { infer: true })),
      },
      changeLeadMinutes: this.leadMinutes,
    };
    if (!period) return { data: [], meta };
    const range = { from: bogotaToUtc(from, 0), to: bogotaToUtc(new Date(to.getTime() + DAY_MS), 0) };
    const rows = await this.prisma.moduleSession.findMany({
      where: {
        teacherId,
        deletedAt: null,
        module: { deletedAt: null, periodId: period.id },
        startsAt: { gte: range.from, lt: range.to },
      },
      include: SESSION_INCLUDE,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return { data: await this.views(rows, this.clock.now(), range), meta };
  }

  // The sessions of the teacher by id, in the order of `ids`, for the answer of a change.
  async byIds(teacherId: string, ids: readonly string[]) {
    const rows = await this.prisma.moduleSession.findMany({
      where: { id: { in: [...ids] }, teacherId },
      include: SESSION_INCLUDE,
    });
    const views = await this.views(rows, this.clock.now());
    return ids.map((id) => views.find((v) => v.id === id)).filter((v) => v !== undefined);
  }

  // The room a session is held in; sessions only keep its id.
  private roomView(room: { id: string; name: string; capacity: number; location: { name: string } } | undefined) {
    return room
      ? { id: room.id, name: room.name, location: room.location.name, capacity: room.capacity }
      : { id: '', name: '', location: '', capacity: 0 };
  }

  private async views(rows: SessionRow[], now: Date, range?: { from: Date; to: Date }) {
    const [seats, rooms] = await Promise.all([
      sessionSeats(this.prisma, [...new Set(rows.map((r) => r.moduleId))], now, range),
      this.prisma.room.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.roomId))] } },
        include: { location: true },
      }),
    ]);
    const roomOf = new Map(rooms.map((r) => [r.id, r]));
    const attendees = new Map(seats.map((s) => [s.sessionId, s.attendees]));
    return rows.map((row) => ({
      id: row.id,
      moduleId: row.moduleId,
      moduleName: row.module.name,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      originalStartsAt: row.originalStartsAt,
      status: row.status,
      cancelReason: row.cancelReason,
      room: this.roomView(roomOf.get(row.roomId)),
      attendees: row.status === 'CANCELLED' ? 0 : (attendees.get(row.id) ?? 0),
      ...sessionChangeActions({
        mine: true,
        readOnly: row.module.period.status === 'CLOSED',
        status: row.status,
        cancelReason: row.cancelReason,
        startsAt: row.startsAt,
        now,
        leadMinutes: this.leadMinutes,
      }),
    }));
  }
}
