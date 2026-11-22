import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { violatedConstraint } from '../common/db-errors.js';
import { AppException } from '../common/errors/app.exception.js';
import { lockModule, lockWritablePeriod } from '../modules/locks.js';
import { formatTime } from '../modules/sessions.rules.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  canCancelSession,
  effectiveUntil,
  findStudentConflict,
  type OwnSlot,
} from './enrollments.rules.js';
import { enrollmentView, OfferService } from './offer.service.js';
import { moduleSeats, sessionSeats } from './seats.js';

const ONE_ACTIVE = 'enrollments_one_active';
const ONE_LIVE_ABSENCE = 'session_absences_one_live';

// Lock order (research.md R-2, D-092): period (shared), student row (enroll only), module (exclusive).
// Two enrollments of one student queue on the student row; two of one module, on the module row.
@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly offer: OfferService,
  ) {}

  async enroll(studentId: string, moduleId: string) {
    const found = await this.prisma.module.findFirst({
      where: { id: moduleId, deletedAt: null },
      select: { periodId: true },
    });
    if (!found) throw new AppException(404, 'NOT_FOUND', 'Module not found');
    try {
      const enrollment = await this.prisma.$transaction(async (tx) => {
        const period = await lockWritablePeriod(tx, found.periodId);
        if (period.status !== 'ACTIVE') {
          throw new AppException(409, 'ENROLLMENT_PERIOD_NOT_OPEN', 'Enrollment is open for the active period only');
        }
        const [student] = await tx.$queryRaw<{ status: string; deleted_at: Date | null }[]>`
          SELECT status, deleted_at FROM users WHERE id = ${studentId}::uuid FOR UPDATE`;
        // A deactivation that committed after the guard checked the session (spec 016).
        if (!student || student.status !== 'ACTIVE' || student.deleted_at) {
          throw new AppException(401, 'ACCOUNT_DISABLED', 'Account disabled');
        }
        await lockModule(tx, moduleId, period.id);
        const module = await tx.module.findFirstOrThrow({
          where: { id: moduleId },
          include: { teacher: true, room: true, schedules: { where: { deletedAt: null } } },
        });
        const now = this.clock.now();
        const seats = await sessionSeats(tx, [moduleId], now);
        const free = moduleSeats(seats, moduleId);
        const unavailable =
          module.teacher.role !== 'TEACHER' ||
          module.teacher.status !== 'ACTIVE' ||
          module.teacher.deletedAt !== null ||
          module.room.status !== 'ACTIVE' ||
          module.room.deletedAt !== null ||
          free === null;
        if (unavailable) {
          throw new AppException(409, 'ENROLLMENT_MODULE_UNAVAILABLE', 'The module is not available for enrollment');
        }
        const mine = await tx.enrollment.findMany({
          where: { studentId, status: 'ACTIVE', deletedAt: null, module: { deletedAt: null, periodId: period.id } },
          include: { module: { include: { schedules: { where: { deletedAt: null } } } } },
        });
        if (mine.some((e) => e.moduleId === moduleId)) {
          throw new AppException(409, 'ENROLLMENT_ALREADY_ACTIVE', 'The student is already enrolled in this module');
        }
        const others: OwnSlot[] = mine.flatMap((e) =>
          e.module.schedules.map((s) => ({
            moduleName: e.module.name,
            dayOfWeek: s.dayOfWeek,
            startMinute: s.startMinute,
            endMinute: s.endMinute,
          })),
        );
        const clash = findStudentConflict(module.schedules, others);
        if (clash) {
          throw new AppException(409, 'ENROLLMENT_SCHEDULE_CONFLICT', 'The schedule overlaps another enrollment', {
            conflict: {
              moduleName: clash.moduleName,
              dayOfWeek: clash.dayOfWeek,
              startTime: formatTime(clash.startMinute),
              endTime: formatTime(clash.endMinute),
            },
          });
        }
        if (free < 1) {
          throw new AppException(409, 'ENROLLMENT_MODULE_FULL', 'A session of the module has no free seat', {
            availableSeats: 0,
            capacity: module.room.capacity,
          });
        }
        return tx.enrollment.create({ data: { studentId, moduleId } });
      });
      return enrollmentView(enrollment);
    } catch (error) {
      throw this.translate(error);
    }
  }

  // Cancelling the module frees the seat from the first session that starts after the lead window
  // (D-091): sessions starting earlier keep the student through `effectiveUntil`.
  async cancelModule(studentId: string, enrollmentId: string) {
    const own = await this.findOwn(studentId, enrollmentId);
    const cancelled = await this.prisma.$transaction(async (tx) => {
      await lockModule(tx, own.module.id, own.module.periodId);
      const current = await tx.enrollment.findFirstOrThrow({ where: { id: enrollmentId } });
      if (current.status !== 'ACTIVE') {
        throw new AppException(409, 'ENROLLMENT_NOT_ACTIVE', 'The enrollment is already cancelled');
      }
      const now = this.clock.now();
      return tx.enrollment.update({
        where: { id: enrollmentId },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          effectiveUntil: effectiveUntil(now, this.offer.leadMinutes),
        },
      });
    });
    return enrollmentView(cancelled);
  }

  cancelSession(studentId: string, enrollmentId: string, sessionId: string) {
    return this.changeSession(studentId, enrollmentId, sessionId, 'cancel');
  }

  restoreSession(studentId: string, enrollmentId: string, sessionId: string) {
    return this.changeSession(studentId, enrollmentId, sessionId, 'restore');
  }

  private async changeSession(studentId: string, enrollmentId: string, sessionId: string, action: 'cancel' | 'restore') {
    const own = await this.findOwn(studentId, enrollmentId);
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockModule(tx, own.module.id, own.module.periodId);
        const current = await tx.enrollment.findFirstOrThrow({ where: { id: enrollmentId } });
        if (current.status !== 'ACTIVE') {
          throw new AppException(409, 'ENROLLMENT_NOT_ACTIVE', 'The enrollment is already cancelled');
        }
        const session = await tx.moduleSession.findFirst({
          where: { id: sessionId, moduleId: own.module.id, deletedAt: null },
        });
        if (!session) throw new AppException(404, 'NOT_FOUND', 'Session not found');
        const now = this.clock.now();
        if (session.startsAt <= now || session.status === 'CANCELLED') {
          throw new AppException(409, 'ENROLLMENT_SESSION_NOT_CANCELLABLE', 'The session has passed or was cancelled');
        }
        const minutes = this.offer.leadMinutes;
        if (!canCancelSession(session.startsAt, now, minutes)) {
          throw new AppException(409, 'ENROLLMENT_CANCEL_WINDOW_PASSED', 'Too close to the session', { minutes });
        }
        const live = await tx.sessionAbsence.findFirst({ where: { enrollmentId, sessionId, deletedAt: null } });
        if (action === 'cancel') {
          if (!live) await tx.sessionAbsence.create({ data: { enrollmentId, sessionId } });
          return;
        }
        if (!live) return;
        const seats = await sessionSeats(tx, [own.module.id], now);
        const free = seats.find((s) => s.sessionId === sessionId)?.freeSeats ?? 0;
        if (free < 1) {
          throw new AppException(409, 'ENROLLMENT_MODULE_FULL', 'The session has no free seat', {
            availableSeats: 0,
            capacity: own.module.room.capacity,
          });
        }
        await tx.sessionAbsence.update({ where: { id: live.id }, data: { deletedAt: now } });
      });
    } catch (error) {
      throw this.translate(error);
    }
    const detail = await this.offer.detail(studentId, own.module.id);
    return detail.sessions.find((s) => s.id === sessionId)!;
  }

  // Only the student's own enrollment: someone else's is a 404, never a 403.
  private async findOwn(studentId: string, enrollmentId: string) {
    const own = await this.prisma.enrollment.findFirst({
      where: { id: enrollmentId, studentId, deletedAt: null, module: { deletedAt: null } },
      include: { module: { include: { room: true } } },
    });
    if (!own) throw new AppException(404, 'NOT_FOUND', 'Enrollment not found');
    return own;
  }

  // A race the checks could not see: the partial unique index refused the second write.
  private translate(error: unknown): unknown {
    const name = violatedConstraint(error, [ONE_ACTIVE, ONE_LIVE_ABSENCE]);
    if (name === ONE_ACTIVE) {
      return new AppException(409, 'ENROLLMENT_ALREADY_ACTIVE', 'The student is already enrolled in this module', {
        violatedConstraint: name,
      });
    }
    return error;
  }
}
