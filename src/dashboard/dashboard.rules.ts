import { BOGOTA_UTC_OFFSET_HOURS, bogotaCalendarDay } from '../common/clock.js';

const DAY_MS = 86_400_000;

export const occupancyPercent = (enrolled: number, capacity: number): number =>
  capacity <= 0 ? 0 : Math.min(100, Math.round((enrolled / capacity) * 1000) / 10);

export type ModuleLoad = 'full' | 'low' | 'normal';

// `low` never applies to a full module: the CAE reads the two counters as separate groups.
export function classifyModule(enrolled: number, capacity: number, lowPercent: number): ModuleLoad {
  if (capacity <= 0) return 'normal';
  if (enrolled >= capacity) return 'full';
  return (enrolled / capacity) * 100 < lowPercent ? 'low' : 'normal';
}

export interface RoomLoad {
  roomId: string;
  name: string;
  location: string;
  percent: number;
  modules: number;
}

// Up to 3 most and 3 least occupied rooms; with 6 or fewer the list is split so no room repeats.
export function rankRooms(rooms: readonly RoomLoad[]): { most: RoomLoad[]; least: RoomLoad[] } {
  const sorted = rooms.filter((r) => r.modules > 0).sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));
  const most = Math.min(3, Math.ceil(sorted.length / 2));
  const least = Math.min(3, sorted.length - most);
  return { most: sorted.slice(0, most), least: sorted.slice(sorted.length - least).reverse() };
}

// Monday 00:00 to the next Monday 00:00 in America/Bogota, as UTC instants.
export function weekRangeBogota(now: Date): { from: Date; to: Date } {
  const day = bogotaCalendarDay(now);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  const from = new Date(day.getTime() - sinceMonday * DAY_MS + BOGOTA_UTC_OFFSET_HOURS * 3_600_000);
  return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
}
