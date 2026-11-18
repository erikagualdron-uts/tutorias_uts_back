import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { dayKey, occurrences } from './sessions.rules.js';

export interface GeneratorSchedule {
  id: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

// Writes the weekly sessions of a module (research.md R-4). Idempotent: the partial unique index on
// (schedule, original start) makes repeating it a no-op, so it also fills the gaps left when a
// holiday is deleted.
@Injectable()
export class SessionsGenerator {
  constructor(private readonly clock: Clock) {}

  // Returns how many sessions were created for each schedule id (zero when none was needed).
  async generate(
    tx: Prisma.TransactionClient,
    params: {
      moduleId: string;
      teacherId: string;
      roomId: string;
      startsOn: Date;
      endsOn: Date;
      schedules: readonly GeneratorSchedule[];
    },
  ): Promise<Map<string, number>> {
    const created = new Map<string, number>(params.schedules.map((s) => [s.id, 0]));
    const holidays = await tx.holiday.findMany({
      where: { deletedAt: null, date: { gte: params.startsOn, lte: params.endsOn } },
      select: { date: true },
    });
    const planned = occurrences({
      startsOn: params.startsOn,
      endsOn: params.endsOn,
      schedules: params.schedules.map((s) => ({ key: s.id, ...s })),
      holidays: new Set(holidays.map((h) => dayKey(h.date))),
      now: this.clock.now(),
    });
    if (planned.length === 0) return created;
    const rows = await tx.moduleSession.createManyAndReturn({
      data: planned.map((o) => ({
        moduleId: params.moduleId,
        scheduleId: o.key,
        teacherId: params.teacherId,
        roomId: params.roomId,
        originalStartsAt: o.startsAt,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      })),
      skipDuplicates: true,
      select: { scheduleId: true },
    });
    for (const row of rows) created.set(row.scheduleId, (created.get(row.scheduleId) ?? 0) + 1);
    return created;
  }
}
