import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/errors/app.exception.js';
import type { Env } from '../config/env.js';
import { parseCalendarDay } from '../periods/periods.rules.js';
import type { HolidayEntry, HolidaysClient } from './holidays-client.js';

const unavailable = () =>
  new AppException(502, 'HOLIDAYS_IMPORT_UNAVAILABLE', 'The holidays service is unavailable');

// Public holidays from Nager.Date (research.md R-9). Only the year and the country leave the
// server; the answer is validated because the service is public and has no guarantees.
@Injectable()
export class NagerHolidaysClient implements HolidaysClient {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async fetchYear(year: number): Promise<HolidayEntry[]> {
    const base = this.config.get('HOLIDAYS_API_BASE_URL', { infer: true });
    const country = this.config.get('HOLIDAYS_COUNTRY', { infer: true });
    let body: unknown;
    try {
      const response = await fetch(`${base}/PublicHolidays/${year}/${country}`, {
        signal: AbortSignal.timeout(this.config.get('HOLIDAYS_TIMEOUT_MS', { infer: true })),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      body = await response.json();
    } catch {
      throw unavailable();
    }
    if (!Array.isArray(body)) throw unavailable();

    const byDate = new Map<string, HolidayEntry>();
    for (const item of body as Record<string, unknown>[]) {
      const date = typeof item?.date === 'string' ? item.date : '';
      const name = [item?.localName, item?.name].find((n): n is string => typeof n === 'string' && n.trim() !== '');
      const isPublic = !Array.isArray(item?.types) || item.types.includes('Public');
      if (parseCalendarDay(date) && date.startsWith(`${year}-`) && name && isPublic) {
        byDate.set(date, { date, name: name.trim().slice(0, 120) });
      }
    }
    if (byDate.size === 0) throw unavailable();
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
