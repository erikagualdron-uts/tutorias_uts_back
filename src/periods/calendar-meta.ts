import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { formatTime } from '../modules/sessions.rules.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { pickCalendarPeriod } from '../teacher-sessions/calendar.rules.js';
import { formatCalendarDay } from './periods.rules.js';
import type { PeriodsService } from './periods.service.js';

// What every weekly calendar (teacher, spec 013; student, spec 021) answers next to its sessions: the period it
// shows (the active one or, without one, the last closed one read only) and the allowed hours of the configuration.
export async function calendarMeta(
  prisma: PrismaService,
  periods: PeriodsService,
  config: ConfigService<Env, true>,
  range: { from: string; to: string },
) {
  await periods.closeExpired();
  const [active, closed] = await Promise.all([
    prisma.academicPeriod.findFirst({ where: { status: 'ACTIVE', deletedAt: null } }),
    prisma.academicPeriod.findFirst({
      where: { status: 'CLOSED', deletedAt: null },
      orderBy: [{ endsOn: 'desc' }, { id: 'asc' }],
    }),
  ]);
  const period = pickCalendarPeriod(active, closed);
  return {
    period,
    meta: {
      from: range.from,
      to: range.to,
      period: period && {
        id: period.id,
        name: period.name,
        startsOn: formatCalendarDay(period.startsOn),
        endsOn: formatCalendarDay(period.endsOn),
        status: period.status as 'ACTIVE' | 'CLOSED',
      },
      hours: {
        earliest: formatTime(config.get('MODULE_EARLIEST_MINUTE', { infer: true })),
        latest: formatTime(config.get('MODULE_LATEST_MINUTE', { infer: true })),
      },
    },
  };
}
