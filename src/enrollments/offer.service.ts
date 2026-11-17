import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Env } from '../config/env.js';
import { formatTime } from '../modules/sessions.rules.js';
import { PeriodsService } from '../periods/periods.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MyEnrollmentsQueryDto, OfferQueryDto } from './dto/enrollment.dto.js';
import { findStudentConflict, sessionActions, type OwnSlot } from './enrollments.rules.js';
import { moduleSeats, sessionSeats, type SessionSeats } from './seats.js';

export const MODULE_INCLUDE = {
  period: true,
  teacher: { include: { teacherProfile: true } },
  room: { include: { location: true } },
  schedules: { where: { deletedAt: null }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
} satisfies Prisma.ModuleInclude;

type ModuleRow = Prisma.ModuleGetPayload<{ include: typeof MODULE_INCLUDE }>;
type EnrollmentRow = Prisma.EnrollmentGetPayload<object>;
type SessionRow = Prisma.ModuleSessionGetPayload<object>;
type MineRow = Prisma.EnrollmentGetPayload<{ include: { module: { include: { schedules: true } } } }>;

export type OfferState = 'AVAILABLE' | 'LAST_SPOTS' | 'FULL' | 'ENROLLED' | 'BLOCKED';

const LAST_SPOTS_RATIO = 0.8;

export const enrollmentView = (e: EnrollmentRow) => ({
  id: e.id,
  moduleId: e.moduleId,
  status: e.status,
  enrolledAt: e.createdAt,
  cancelledAt: e.cancelledAt,
  effectiveUntil: e.effectiveUntil,
});

// Offer, detail and "my enrollments" for students. Everything is loaded in bulk: a few queries per
// request, never one per card.
@Injectable()
export class OfferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
    private readonly periods: PeriodsService,
  ) {}

  get leadMinutes(): number {
    return this.config.get('STUDENT_CANCEL_LEAD_MINUTES', { infer: true });
  }

  async list(studentId: string, query: OfferQueryDto) {
    await this.periods.closeExpired();
    const period = await this.prisma.academicPeriod.findFirst({ where: { status: 'ACTIVE', deletedAt: null } });
    const meta = { page: query.page, limit: query.limit, periodId: period?.id ?? null };
    if (!period) return { data: [], meta: { ...meta, total: 0 } };
    const where: Prisma.ModuleWhereInput = {
      periodId: period.id,
      deletedAt: null,
      ...(query.search && { name: { contains: query.search, mode: 'insensitive' } }),
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
    return { data: await this.moduleViews(studentId, rows), meta: { ...meta, total } };
  }

  // Offered (active period) or already the student's own (any enrollment, so history stays readable).
  async detail(studentId: string, moduleId: string) {
    await this.periods.closeExpired();
    const row = await this.prisma.module.findFirst({ where: { id: moduleId, deletedAt: null }, include: MODULE_INCLUDE });
    if (!row) throw new AppException(404, 'NOT_FOUND', 'Module not found');
    if (row.period.status !== 'ACTIVE') {
      const had = await this.prisma.enrollment.count({ where: { studentId, moduleId, deletedAt: null } });
      if (had === 0) throw new AppException(404, 'NOT_FOUND', 'Module not found');
    }
    const [view] = await this.moduleViews(studentId, [row]);
    const readOnly = row.period.status === 'CLOSED';
    const active = await this.prisma.enrollment.findFirst({
      where: { studentId, moduleId, status: 'ACTIVE', deletedAt: null },
    });
    const sessions = readOnly
      ? []
      : ((await this.sessionViews([row.id], new Map(active ? [[row.id, active]] : []))).get(row.id) ?? []);
    return { ...view, readOnly, cancelLeadMinutes: this.leadMinutes, sessions };
  }

  async myEnrollments(studentId: string, query: MyEnrollmentsQueryDto) {
    await this.periods.closeExpired();
    const rows = await this.prisma.enrollment.findMany({
      where: {
        studentId,
        deletedAt: null,
        module: { deletedAt: null },
        ...(query.status !== 'ALL' && { status: query.status }),
      },
      include: { module: { include: MODULE_INCLUDE } },
    });
    const views = new Map((await this.moduleViews(studentId, rows.map((r) => r.module))).map((v) => [v.id, v]));
    const active = new Map(rows.filter((r) => r.status === 'ACTIVE').map((r) => [r.moduleId, r]));
    const sessions = await this.sessionViews([...active.keys()], active);
    const items = rows.map((r) => {
      const readOnly = r.module.period.status === 'CLOSED';
      const upcoming = r.status === 'ACTIVE' && !readOnly ? (sessions.get(r.moduleId) ?? []) : [];
      return {
        ...enrollmentView(r),
        module: views.get(r.moduleId)!,
        readOnly,
        nextSession: upcoming[0] ?? null,
        upcomingSessions: upcoming.filter((s) => s.status !== 'CANCELLED').length,
      };
    });
    items.sort((a, b) => {
      const at = a.nextSession ? a.nextSession.startsAt.getTime() : Infinity;
      const bt = b.nextSession ? b.nextSession.startsAt.getTime() : Infinity;
      return at === bt ? b.enrolledAt.getTime() - a.enrolledAt.getTime() : at < bt ? -1 : 1;
    });
    const start = (query.page - 1) * query.limit;
    return {
      data: items.slice(start, start + query.limit),
      meta: { page: query.page, limit: query.limit, total: items.length },
    };
  }

  // The `StudentModule` of the contract for several modules at once.
  private async moduleViews(studentId: string, rows: ModuleRow[]) {
    const seats = await sessionSeats(this.prisma, rows.map((r) => r.id), this.clock.now());
    const mine = await this.prisma.enrollment.findMany({
      where: { studentId, status: 'ACTIVE', deletedAt: null, module: { deletedAt: null } },
      include: { module: { include: { schedules: { where: { deletedAt: null } } } } },
    });
    return rows.map((row) => moduleView(row, seats, mine));
  }

  // Future sessions of modules where the student has an ACTIVE enrollment (`active`, by module).
  private async sessionViews(moduleIds: string[], active: Map<string, EnrollmentRow>) {
    const result = new Map<string, ReturnType<typeof sessionView>[]>();
    if (moduleIds.length === 0) return result;
    const now = this.clock.now();
    const [sessions, seats, absences, modules] = await Promise.all([
      this.prisma.moduleSession.findMany({
        where: { moduleId: { in: moduleIds }, deletedAt: null, startsAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
      }),
      sessionSeats(this.prisma, moduleIds, now),
      this.prisma.sessionAbsence.findMany({
        where: { enrollmentId: { in: [...active.values()].map((e) => e.id) }, deletedAt: null },
        select: { enrollmentId: true, sessionId: true },
      }),
      this.prisma.module.findMany({
        where: { id: { in: moduleIds } },
        select: { id: true, period: { select: { status: true } } },
      }),
    ]);
    const absent = new Set(absences.map((a) => `${a.enrollmentId}:${a.sessionId}`));
    const free = new Map(seats.map((s) => [s.sessionId, s.freeSeats]));
    const closed = new Set(modules.filter((m) => m.period.status === 'CLOSED').map((m) => m.id));
    for (const session of sessions) {
      const enrollment = active.get(session.moduleId);
      const view = sessionView(session, {
        enrolled: enrollment !== undefined,
        readOnly: closed.has(session.moduleId),
        absent: enrollment !== undefined && absent.has(`${enrollment.id}:${session.id}`),
        freeSeats: free.get(session.id) ?? 0,
        now,
        leadMinutes: this.leadMinutes,
      });
      const list = result.get(session.moduleId) ?? [];
      list.push(view);
      result.set(session.moduleId, list);
    }
    return result;
  }
}

function moduleView(row: ModuleRow, seats: readonly SessionSeats[], mine: MineRow[]) {
  const capacity = row.room.capacity;
  const free = moduleSeats(seats, row.id);
  const availableSeats = free ?? 0;
  const own = mine.find((e) => e.moduleId === row.id) ?? null;
  const target = row.schedules.map((s) => ({
    dayOfWeek: s.dayOfWeek,
    startMinute: s.startMinute,
    endMinute: s.endMinute,
  }));
  const others: OwnSlot[] = mine
    .filter((e) => e.moduleId !== row.id && e.module.periodId === row.periodId)
    .flatMap((e) =>
      e.module.schedules.map((s) => ({
        moduleName: e.module.name,
        dayOfWeek: s.dayOfWeek,
        startMinute: s.startMinute,
        endMinute: s.endMinute,
      })),
    );
  const clash = findStudentConflict(target, others);
  const unavailable =
    row.period.status !== 'ACTIVE' ||
    row.teacher.role !== 'TEACHER' ||
    row.teacher.status !== 'ACTIVE' ||
    row.teacher.deletedAt !== null ||
    row.room.status !== 'ACTIVE' ||
    row.room.deletedAt !== null ||
    free === null;
  let state: OfferState = 'AVAILABLE';
  let blockReason: 'SCHEDULE_CONFLICT' | 'UNAVAILABLE' | null = null;
  if (own) state = 'ENROLLED';
  else if (unavailable) [state, blockReason] = ['BLOCKED', 'UNAVAILABLE'];
  else if (clash) [state, blockReason] = ['BLOCKED', 'SCHEDULE_CONFLICT'];
  else if (availableSeats === 0) state = 'FULL';
  else if (capacity - availableSeats >= capacity * LAST_SPOTS_RATIO) state = 'LAST_SPOTS';
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    teacher: {
      id: row.teacher.id,
      firstName: row.teacher.teacherProfile?.firstName ?? '',
      lastName: row.teacher.teacherProfile?.lastName ?? '',
    },
    room: { id: row.room.id, name: row.room.name, location: row.room.location.name, capacity },
    schedules: row.schedules.map((s) => ({
      dayOfWeek: s.dayOfWeek,
      startTime: formatTime(s.startMinute),
      endTime: formatTime(s.endMinute),
    })),
    capacity,
    availableSeats,
    state,
    blockReason,
    conflict:
      blockReason === 'SCHEDULE_CONFLICT' && clash
        ? {
            moduleName: clash.moduleName,
            dayOfWeek: clash.dayOfWeek,
            startTime: formatTime(clash.startMinute),
            endTime: formatTime(clash.endMinute),
          }
        : null,
    enrollment: own ? { id: own.id, enrolledAt: own.createdAt } : null,
  };
}

function sessionView(
  session: SessionRow,
  ctx: { enrolled: boolean; readOnly: boolean; absent: boolean; freeSeats: number; now: Date; leadMinutes: number },
) {
  const actions = sessionActions({
    enrolled: ctx.enrolled,
    readOnly: ctx.readOnly,
    status: session.status,
    startsAt: session.startsAt,
    now: ctx.now,
    leadMinutes: ctx.leadMinutes,
    absent: ctx.absent,
    freeSeats: ctx.freeSeats,
  });
  return {
    id: session.id,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    status: session.status,
    cancelReason: session.cancelReason,
    cancelledByStudent: ctx.absent,
    freeSeats: session.status === 'CANCELLED' ? 0 : ctx.freeSeats,
    ...actions,
  };
}
