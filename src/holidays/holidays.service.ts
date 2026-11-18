import { Inject, Injectable } from '@nestjs/common';
import type { Holiday, Prisma } from '@prisma/client';
import { bogotaCalendarDay, Clock } from '../common/clock.js';
import { violatedConstraint } from '../common/db-errors.js';
import { AppException } from '../common/errors/app.exception.js';
import { SessionsGenerator } from '../modules/sessions.generator.js';
import { bogotaToUtc, dayKey } from '../modules/sessions.rules.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { parseCalendarDay } from '../periods/periods.rules.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { HolidayDto, ImportHolidaysDto } from './dto/holiday.dto.js';
import { HOLIDAYS_CLIENT, type HolidaysClient } from './holidays-client.js';

const DAY_MS = 86_400_000;
const DATE_INDEX = 'holidays_date_unique_idx';

type Tx = Prisma.TransactionClient;
// Sessions of a closed period never change, not even for a holiday (FR-015).
const OPEN_MODULE = { deletedAt: null, period: { status: { not: 'CLOSED' } } } satisfies Prisma.ModuleWhereInput;

export interface HolidayRemoval {
  restored: number;
  generated: number;
  notRestored: { sessionId: string; moduleId: string; reason: 'TEACHER_BUSY' | 'ROOM_BUSY' }[];
}

// Holidays (research.md R-8): a global calendar. Registering one cancels the future sessions of
// that date; deleting one gives them back, or generates the ones that were never created.
@Injectable()
export class HolidaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly generator: SessionsGenerator,
    @Inject(HOLIDAYS_CLIENT) private readonly client: HolidaysClient,
  ) {}

  async list(year: number) {
    const rows = await this.holidaysOf(year);
    return { data: rows.map((h) => this.view(h)) };
  }

  async create(dto: HolidayDto) {
    const date = this.futureDay(dto.date);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertDateFree(tx, date);
        const holiday = await tx.holiday.create({ data: { date, name: dto.name } });
        return { holiday: this.view(holiday), cancelledSessions: await this.cancelSessions(tx, holiday) };
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  // Moving a holiday to another day gives the old day back and cancels the new one.
  async update(id: string, dto: HolidayDto) {
    const current = await this.findLive(id);
    this.assertNotPast(current.date);
    const date = this.futureDay(dto.date);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertDateFree(tx, date, id);
        const moved = date.getTime() !== current.date.getTime();
        const holiday = await tx.holiday.update({ where: { id }, data: { date, name: dto.name } });
        if (!moved) return { holiday: this.view(holiday), cancelledSessions: 0 };
        await this.restore(tx, { id, date: current.date });
        return { holiday: this.view(holiday), cancelledSessions: await this.cancelSessions(tx, holiday) };
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async remove(id: string): Promise<HolidayRemoval> {
    const holiday = await this.findLive(id);
    this.assertNotPast(holiday.date);
    return this.prisma.$transaction(async (tx) => {
      await tx.holiday.update({ where: { id }, data: { deletedAt: this.clock.now() } });
      return this.restore(tx, holiday);
    });
  }

  // FR-023: nothing is saved here; the person reviews the list first.
  async preview(year: number) {
    const entries = await this.client.fetchYear(year);
    const existing = new Set((await this.holidaysOf(year)).map((h) => dayKey(h.date)));
    const today = this.today();
    return {
      data: entries.map((e) => ({
        ...e,
        alreadyExists: existing.has(e.date),
        isPast: parseCalendarDay(e.date)!.getTime() < today.getTime(),
      })),
    };
  }

  // The service is asked again and only the confirmed dates it still lists are saved, all or none.
  async import(dto: ImportHolidaysDto) {
    const wanted = new Set(dto.dates);
    const entries = (await this.client.fetchYear(dto.year)).filter((e) => wanted.has(e.date));
    const today = this.today();
    return this.prisma.$transaction(async (tx) => {
      let created = 0;
      let cancelledSessions = 0;
      for (const entry of entries) {
        const date = parseCalendarDay(entry.date)!;
        if (date.getTime() < today.getTime() || (await tx.holiday.findFirst({ where: { date, deletedAt: null } }))) continue;
        const holiday = await tx.holiday.create({ data: { date, name: entry.name, source: 'IMPORTED' } });
        created++;
        cancelledSessions += await this.cancelSessions(tx, holiday);
      }
      return { created, skipped: wanted.size - created, cancelledSessions };
    });
  }

  // The future SCHEDULED sessions of the holiday (in Bogota) become CANCELLED for that reason.
  private async cancelSessions(tx: Tx, holiday: Holiday): Promise<number> {
    const sessions = await tx.moduleSession.findMany({
      where: {
        status: 'SCHEDULED',
        deletedAt: null,
        startsAt: { gt: this.clock.now(), ...this.dayRange(holiday.date) },
        module: OPEN_MODULE,
      },
      select: { id: true, moduleId: true },
    });
    if (sessions.length === 0) return 0;
    await tx.moduleSession.updateMany({
      where: { id: { in: sessions.map((s) => s.id) } },
      data: { status: 'CANCELLED', cancelReason: 'HOLIDAY', holidayId: holiday.id },
    });
    await this.record(tx, 'SESSIONS_CANCELLED_HOLIDAY', holiday.date, this.countBy(sessions.map((s) => s.moduleId)));
    return sessions.length;
  }

  // Gives back the sessions cancelled by the holiday unless the room or the teacher is busy by now,
  // and generates the ones that were never created because the holiday already existed.
  private async restore(tx: Tx, holiday: Pick<Holiday, 'id' | 'date'>): Promise<HolidayRemoval> {
    const cancelled = await tx.moduleSession.findMany({
      where: { holidayId: holiday.id, deletedAt: null, startsAt: { gt: this.clock.now() }, module: OPEN_MODULE },
    });
    const result: HolidayRemoval = { restored: 0, generated: 0, notRestored: [] };
    const restoredBy = new Map<string, number>();
    for (const session of cancelled) {
      const busy = await tx.moduleSession.findFirst({
        where: {
          id: { not: session.id },
          deletedAt: null,
          status: { not: 'CANCELLED' },
          startsAt: { lt: session.endsAt },
          endsAt: { gt: session.startsAt },
          OR: [{ roomId: session.roomId }, { teacherId: session.teacherId }],
        },
      });
      if (busy) {
        result.notRestored.push({
          sessionId: session.id,
          moduleId: session.moduleId,
          reason: busy.roomId === session.roomId ? 'ROOM_BUSY' : 'TEACHER_BUSY',
        });
        continue;
      }
      await tx.moduleSession.update({
        where: { id: session.id },
        data: { status: 'SCHEDULED', cancelReason: null, holidayId: null },
      });
      result.restored++;
      restoredBy.set(session.moduleId, (restoredBy.get(session.moduleId) ?? 0) + 1);
    }

    const modules = await tx.module.findMany({
      where: { ...OPEN_MODULE, period: { status: { not: 'CLOSED' }, startsOn: { lte: holiday.date }, endsOn: { gte: holiday.date } } },
      include: { schedules: { where: { deletedAt: null } } },
    });
    const generatedBy = new Map<string, number>();
    for (const module of modules) {
      const made = await this.generator.generate(tx, {
        moduleId: module.id,
        teacherId: module.teacherId,
        roomId: module.roomId,
        startsOn: holiday.date,
        endsOn: holiday.date,
        schedules: module.schedules,
      });
      const total = [...made.values()].reduce((sum, n) => sum + n, 0);
      if (total > 0) generatedBy.set(module.id, total);
    }
    result.generated = [...generatedBy.values()].reduce((sum, n) => sum + n, 0);

    for (const moduleId of new Set([...restoredBy.keys(), ...generatedBy.keys()])) {
      await this.outbox.record(tx, {
        type: 'SESSIONS_RESTORED_HOLIDAY',
        moduleId,
        payload: { date: dayKey(holiday.date), restored: restoredBy.get(moduleId) ?? 0, generated: generatedBy.get(moduleId) ?? 0 },
      });
    }
    return result;
  }

  private async record(tx: Tx, type: 'SESSIONS_CANCELLED_HOLIDAY', date: Date, perModule: Map<string, number>) {
    for (const [moduleId, sessions] of perModule) {
      await this.outbox.record(tx, { type, moduleId, payload: { date: dayKey(date), sessions } });
    }
  }

  private countBy(ids: string[]) {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }

  private dayRange(date: Date) {
    return { gte: bogotaToUtc(date, 0), lt: bogotaToUtc(new Date(date.getTime() + DAY_MS), 0) };
  }

  private today() {
    return bogotaCalendarDay(this.clock.now());
  }

  private view(holiday: Holiday) {
    return {
      id: holiday.id,
      date: dayKey(holiday.date),
      name: holiday.name,
      source: holiday.source,
      isPast: holiday.date.getTime() < this.today().getTime(),
    };
  }

  private holidaysOf(year: number) {
    return this.prisma.holiday.findMany({
      where: {
        deletedAt: null,
        date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) },
      },
      orderBy: { date: 'asc' },
    });
  }

  private async findLive(id: string) {
    const holiday = await this.prisma.holiday.findFirst({ where: { id, deletedAt: null } });
    if (!holiday) throw new AppException(404, 'NOT_FOUND', 'Holiday not found');
    return holiday;
  }

  private futureDay(value: string): Date {
    const date = parseCalendarDay(value);
    if (!date) throw new AppException(400, 'VALIDATION_FAILED', 'Not a calendar day');
    this.assertNotPast(date);
    return date;
  }

  private assertNotPast(date: Date) {
    if (date.getTime() < this.today().getTime()) {
      throw new AppException(409, 'HOLIDAY_IN_PAST', 'A holiday before today cannot be added, edited or deleted');
    }
  }

  private async assertDateFree(tx: Tx, date: Date, exceptId?: string) {
    const taken = await tx.holiday.findFirst({
      where: { date, deletedAt: null, ...(exceptId && { id: { not: exceptId } }) },
    });
    if (taken) throw new AppException(409, 'HOLIDAY_DATE_TAKEN', 'A holiday is already registered on that date');
  }

  // Two requests for the same day: the unique index let only one through.
  private translate(error: unknown): unknown {
    return violatedConstraint(error, [DATE_INDEX])
      ? new AppException(409, 'HOLIDAY_DATE_TAKEN', 'A holiday is already registered on that date')
      : error;
  }
}
