import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { violatedConstraint } from '../common/db-errors.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ScheduleDto } from './dto/module.dto.js';
import {
  findOverlappingSlots,
  formatTime,
  parseTime,
  rangesOverlap,
  type Slot,
  validateSlot,
} from './sessions.rules.js';

const CONSTRAINTS = [
  'module_schedules_teacher_no_overlap',
  'module_schedules_room_no_overlap',
  'module_schedules_self_no_overlap',
] as const;

export interface ConflictInfo {
  moduleName: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface AvailabilityParams {
  teacherId: string;
  roomId: string;
  periodId: string;
  slots: readonly Slot[];
  ignoreModuleId?: string;
}

type Db = PrismaService | Prisma.TransactionClient;

// Validation of weekly slots and of their overlaps with other modules (research.md R-1). The
// database exclusion constraints are the last word; this service reads first so the answer can
// name the module and the hours that collide.
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // "HH:mm" slots to minutes, rejecting an end that is not after the start and slots of the same
  // module that overlap (FR-003), and slots outside the configured hours.
  parse(input: readonly ScheduleDto[]): Slot[] {
    const slots = input.map((s): Slot => {
      const startMinute = parseTime(s.startTime);
      const endMinute = parseTime(s.endTime);
      if (startMinute === null || endMinute === null) {
        throw new AppException(422, 'MODULE_SCHEDULE_INVALID', 'A time is not a real hour of the day');
      }
      return { dayOfWeek: s.dayOfWeek, startMinute, endMinute };
    });
    if (!slots.every(validateSlot)) {
      throw new AppException(
        422,
        'MODULE_SCHEDULE_INVALID',
        'Each slot needs an end after its start, in the same day',
      );
    }
    const earliest = this.config.get('MODULE_EARLIEST_MINUTE', { infer: true });
    const latest = this.config.get('MODULE_LATEST_MINUTE', { infer: true });
    if (slots.some((s) => s.startMinute < earliest || s.endMinute > latest)) {
      throw new AppException(
        422,
        'MODULE_SCHEDULE_OUT_OF_HOURS',
        'A slot is outside the hours modules can be held',
        { earliest: formatTime(earliest), latest: formatTime(latest) },
      );
    }
    if (findOverlappingSlots(slots)) {
      throw new AppException(409, 'MODULE_SCHEDULE_SELF_OVERLAP', 'Two slots of the module overlap');
    }
    return slots;
  }

  // The first existing slot of another live module that overlaps one of `slots` for the same
  // teacher or room in the same period, or null.
  async findConflict(
    db: Db,
    params: {
      kind: 'teacher' | 'room';
      id: string;
      periodId: string;
      slots: readonly Slot[];
      ignoreModuleId?: string;
    },
  ): Promise<ConflictInfo | null> {
    const existing = await db.moduleSchedule.findMany({
      where: {
        periodId: params.periodId,
        deletedAt: null,
        ...(params.kind === 'teacher' ? { teacherId: params.id } : { roomId: params.id }),
        module: { deletedAt: null },
        ...(params.ignoreModuleId && { moduleId: { not: params.ignoreModuleId } }),
      },
      include: { module: { select: { name: true } } },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    });
    for (const slot of params.slots) {
      const hit = existing.find(
        (row) =>
          row.dayOfWeek === slot.dayOfWeek &&
          rangesOverlap(slot.startMinute, slot.endMinute, row.startMinute, row.endMinute),
      );
      if (hit) {
        return {
          moduleName: hit.module.name,
          dayOfWeek: hit.dayOfWeek,
          startTime: formatTime(hit.startMinute),
          endTime: formatTime(hit.endMinute),
        };
      }
    }
    return null;
  }

  // Checks the teacher first, then the room; throws the rule with the colliding module in `details`.
  async assertFree(db: Db, params: AvailabilityParams): Promise<void> {
    const teacher = await this.findConflict(db, { kind: 'teacher', id: params.teacherId, ...params });
    if (teacher) {
      throw new AppException(409, 'MODULE_TEACHER_CONFLICT', 'The teacher has another module at that time', {
        conflict: teacher,
      });
    }
    const room = await this.findConflict(db, { kind: 'room', id: params.roomId, ...params });
    if (room) {
      throw new AppException(409, 'MODULE_ROOM_CONFLICT', 'The room is taken at that time', { conflict: room });
    }
  }

  // A race the pre-check could not see: the exclusion constraint refused the second write.
  async translate(error: unknown, params: AvailabilityParams): Promise<unknown> {
    const name = violatedConstraint(error, CONSTRAINTS);
    if (!name) return error;
    if (name === 'module_schedules_self_no_overlap') {
      return new AppException(409, 'MODULE_SCHEDULE_SELF_OVERLAP', 'Two slots of the module overlap');
    }
    const kind = name === 'module_schedules_teacher_no_overlap' ? 'teacher' : 'room';
    const conflict = await this.findConflict(this.prisma, {
      kind,
      id: kind === 'teacher' ? params.teacherId : params.roomId,
      periodId: params.periodId,
      slots: params.slots,
      ignoreModuleId: params.ignoreModuleId,
    });
    const details = conflict ? { conflict } : undefined;
    return kind === 'teacher'
      ? new AppException(409, 'MODULE_TEACHER_CONFLICT', 'The teacher has another module at that time', details)
      : new AppException(409, 'MODULE_ROOM_CONFLICT', 'The room is taken at that time', details);
  }
}
