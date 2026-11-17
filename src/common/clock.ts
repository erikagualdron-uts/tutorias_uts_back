import { Global, Injectable, Module } from '@nestjs/common';

// Injected instead of `new Date()` so the e2e tests can move time (session expiry, code TTL).
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}

export const BOGOTA_UTC_OFFSET_HOURS = 5; // America/Bogota is UTC-5 all year (no daylight saving)

// Instant (UTC) at which the calendar day `day` (YYYY-MM-DD or Date at UTC midnight) ends in
// America/Bogota: the next day at 00:00 Bogota time.
export function endOfDayInBogotaUtc(day: Date): Date {
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, BOGOTA_UTC_OFFSET_HOURS),
  );
}

// Calendar day (as a UTC-midnight Date) of `instant` in America/Bogota.
export function bogotaCalendarDay(instant: Date): Date {
  const shifted = new Date(instant.getTime() - BOGOTA_UTC_OFFSET_HOURS * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}
