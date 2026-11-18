import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Env } from '../config/env.js';
import { lockModule, lockRoomsAndTeachers, lockWritablePeriod } from '../modules/locks.js';
import { dayKey, formatTime } from '../modules/sessions.rules.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RescheduleDto } from './dto/teacher-sessions.dto.js';
import { countStudentConflicts, findResourceConflict } from './session-availability.js';
import { TeacherScheduleService } from './teacher-schedule.service.js';
import { rescheduledPayload, type SessionScope } from './teacher-sessions.events.js';
import { canChangeSession, isWithinHours, shiftSession, validateReschedule } from './teacher-sessions.rules.js';

type Db = PrismaService | Prisma.TransactionClient;
type Session = Prisma.ModuleSessionGetPayload<object>;
type Found = Session & { module: { periodId: string; period: { status: string; startsOn: Date; endsOn: Date } } };

interface Move {
  session: Session;
  startsAt: Date;
  endsAt: Date;
  status: 'SCHEDULED' | 'RESCHEDULED';
}

// Lock order (research.md R-4, D-096): period (shared), module (exclusive), then the rooms and the
// teachers of the sessions that move, each by id. Two changes that touch the same room or teacher
// queue instead of both passing the availability check.
@Injectable()
export class TeacherSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
    private readonly outbox: OutboxService,
    private readonly schedule: TeacherScheduleService,
  ) {}

  async reschedule(teacherId: string, sessionId: string, dto: RescheduleDto) {
    const found = await this.find(this.prisma, teacherId, sessionId);
    const newStart = new Date(dto.startsAt);
    if (dto.dryRun) {
      if (found.module.period.status === 'CLOSED') this.closed();
      const moves = await this.plan(this.prisma, found, dto.scope, newStart);
      return this.answer(teacherId, dto.scope, moves, true);
    }
    const moves = await this.prisma.$transaction(async (tx) => {
      await lockWritablePeriod(tx, found.module.periodId);
      await lockModule(tx, found.moduleId, found.module.periodId);
      const fresh = await this.find(tx, teacherId, sessionId);
      const planned = await this.affected(tx, fresh, dto.scope);
      await lockRoomsAndTeachers(tx, [...new Set(planned.map((s) => s.roomId))], [...new Set(planned.map((s) => s.teacherId))]);
      const result = await this.plan(tx, fresh, dto.scope, newStart);
      for (const move of result) {
        await tx.moduleSession.update({
          where: { id: move.session.id },
          data: { startsAt: move.startsAt, endsAt: move.endsAt, status: move.status },
        });
      }
      await this.outbox.record(tx, {
        type: 'SESSION_RESCHEDULED',
        moduleId: found.moduleId,
        payload: rescheduledPayload(
          dto.scope,
          result.map((m) => ({ sessionId: m.session.id, from: m.session.startsAt, to: m.startsAt })),
        ),
      });
      return result;
    });
    return this.answer(teacherId, dto.scope, moves, false);
  }

  // Only the teacher's own sessions: someone else's is a 404, never a 403.
  private async find(db: Db, teacherId: string, sessionId: string): Promise<Found> {
    const session = await db.moduleSession.findFirst({
      where: { id: sessionId, teacherId, deletedAt: null, module: { deletedAt: null } },
      include: { module: { select: { periodId: true, period: { select: { status: true, startsOn: true, endsOn: true } } } } },
    });
    if (!session) throw new AppException(404, 'NOT_FOUND', 'Session not found');
    return session;
  }

  private closed(): never {
    throw new AppException(409, 'PERIOD_CLOSED_READ_ONLY', 'A closed period is read-only');
  }

  // The sessions a change touches: only the chosen one, or it and the future ones of its weekly slot.
  private async affected(db: Db, session: Session, scope: SessionScope): Promise<Session[]> {
    if (scope === 'SESSION') return [session];
    return db.moduleSession.findMany({
      where: {
        moduleId: session.moduleId,
        scheduleId: session.scheduleId,
        teacherId: session.teacherId,
        deletedAt: null,
        startsAt: { gte: session.startsAt },
        status: { in: ['SCHEDULED', 'RESCHEDULED'] },
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  // Every rule of a reschedule, without writing: the answer of `dryRun` and the checks before a write.
  private async plan(db: Db, found: Found, scope: SessionScope, newStart: Date): Promise<Move[]> {
    const now = this.clock.now();
    if (found.module.period.status === 'CLOSED') this.closed();
    if (found.startsAt <= now) {
      throw new AppException(409, 'SESSION_NOT_CHANGEABLE', 'The session has already passed', { reason: 'PAST' });
    }
    if (found.status === 'CANCELLED') {
      throw new AppException(409, 'SESSION_NOT_CHANGEABLE', 'The session is cancelled', { reason: 'CANCELLED' });
    }
    const minutes = this.schedule.leadMinutes;
    if (!canChangeSession(found.startsAt, now, minutes)) {
      throw new AppException(409, 'SESSION_CHANGE_WINDOW_PASSED', 'Too close to the session', { minutes });
    }
    const sessions = await this.affected(db, found, scope);
    const { startsOn, endsOn } = found.module.period;
    const holidays = await db.holiday.findMany({
      where: { deletedAt: null, date: { gte: startsOn, lte: endsOn } },
      select: { date: true },
    });
    const holidayDays = new Set(holidays.map((h) => dayKey(h.date)));
    const earliest = this.config.get('MODULE_EARLIEST_MINUTE', { infer: true });
    const latest = this.config.get('MODULE_LATEST_MINUTE', { infer: true });
    const delta = newStart.getTime() - found.startsAt.getTime();
    const moves: Move[] = [];
    for (const session of sessions) {
      const shifted = shiftSession(session.startsAt, session.endsAt, delta);
      const at = scope === 'SERIES' ? { sessionId: session.id } : {};
      const invalid = validateReschedule({
        currentStart: session.startsAt,
        newStart: shifted.startsAt,
        now,
        periodStartsOn: startsOn,
        periodEndsOn: endsOn,
        holidayDays,
      });
      if (invalid) {
        throw new AppException(422, 'SESSION_RESCHEDULE_INVALID_DATE', 'The new date is not valid', { ...invalid, ...at });
      }
      if (!isWithinHours(shifted.startsAt, shifted.endsAt, earliest, latest)) {
        throw new AppException(422, 'MODULE_SCHEDULE_OUT_OF_HOURS', 'Out of the allowed hours', {
          earliest: formatTime(earliest),
          latest: formatTime(latest),
          ...at,
        });
      }
      const clash = await findResourceConflict(db, {
        roomId: session.roomId,
        teacherId: session.teacherId,
        startsAt: shifted.startsAt,
        endsAt: shifted.endsAt,
        ignoreSessionIds: sessions.map((s) => s.id),
      });
      if (clash) {
        throw new AppException(
          409,
          clash.kind === 'teacher' ? 'MODULE_TEACHER_CONFLICT' : 'MODULE_ROOM_CONFLICT',
          'The teacher or the room is busy at that time',
          { conflict: clash.conflict, ...at },
        );
      }
      const students = await countStudentConflicts(db, { sessionId: session.id, ...shifted });
      if (students > 0) {
        throw new AppException(409, 'SESSION_STUDENT_CONFLICT', 'Enrolled students have another session then', {
          students,
          ...at,
        });
      }
      moves.push({
        session,
        ...shifted,
        status: shifted.startsAt.getTime() === session.originalStartsAt.getTime() ? 'SCHEDULED' : 'RESCHEDULED',
      });
    }
    return moves;
  }

  // The sessions as the teacher sees them: after a write from the database; on a dry run, the current
  // ones with the new hours the change would give them.
  private async answer(teacherId: string, scope: SessionScope, moves: Move[], dryRun: boolean) {
    const views = await this.schedule.byIds(teacherId, moves.map((m) => m.session.id));
    const sessions = dryRun
      ? views.map((view) => {
          const move = moves.find((m) => m.session.id === view.id)!;
          return { ...view, startsAt: move.startsAt, endsAt: move.endsAt, status: move.status };
        })
      : views;
    return { scope, dryRun, sessions };
  }
}
