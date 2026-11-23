import { describe, expect, it } from 'vitest';
import { classifyModule, occupancyPercent, rankRooms, weekRangeBogota, type RoomLoad } from './dashboard.rules.js';

describe('occupancyPercent', () => {
  it('is 0 with no capacity and never above 100', () => {
    expect(occupancyPercent(5, 0)).toBe(0);
    expect(occupancyPercent(40, 30)).toBe(100);
  });

  it('rounds to one decimal', () => {
    expect(occupancyPercent(1, 3)).toBe(33.3);
    expect(occupancyPercent(18, 30)).toBe(60);
  });
});

describe('classifyModule', () => {
  it('is full when enrolled reaches the capacity', () => {
    expect(classifyModule(30, 30, 30)).toBe('full');
    expect(classifyModule(31, 30, 30)).toBe('full');
  });

  it('is low below the threshold and normal at or above it', () => {
    expect(classifyModule(8, 30, 30)).toBe('low'); // 26.7 %
    expect(classifyModule(9, 30, 30)).toBe('normal'); // exactly 30 %
    expect(classifyModule(0, 30, 30)).toBe('low');
  });

  it('follows the configured threshold', () => {
    expect(classifyModule(9, 30, 50)).toBe('low');
  });

  it('is normal with no capacity', () => {
    expect(classifyModule(0, 0, 30)).toBe('normal');
  });
});

describe('rankRooms', () => {
  const room = (name: string, percent: number, modules = 1): RoomLoad => ({ roomId: name, name, location: 'Sede', percent, modules });
  const names = (rooms: RoomLoad[]) => rooms.map((r) => r.name);

  it('takes 3 most and 3 least with more than 6 rooms', () => {
    const rooms = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n, i) => room(n, 100 - i * 10));
    const { most, least } = rankRooms(rooms);
    expect(names(most)).toEqual(['A', 'B', 'C']);
    expect(names(least)).toEqual(['G', 'F', 'E']);
  });

  it('never repeats a room with 6 or fewer', () => {
    const { most, least } = rankRooms([room('A', 90), room('B', 70), room('C', 50), room('D', 20)]);
    expect(names(most)).toEqual(['A', 'B']);
    expect(names(least)).toEqual(['D', 'C']);
    expect(rankRooms([room('A', 10)])).toEqual({ most: [room('A', 10)], least: [] });
  });

  it('breaks ties by name and ignores rooms without modules', () => {
    const { most } = rankRooms([room('B', 50), room('A', 50), room('Z', 99, 0)]);
    expect(names(most)).toEqual(['A']);
    expect(rankRooms([room('Z', 99, 0)])).toEqual({ most: [], least: [] });
  });
});

describe('weekRangeBogota', () => {
  const iso = (range: { from: Date; to: Date }) => [range.from.toISOString(), range.to.toISOString()];

  it('runs Monday 00:00 to next Monday 00:00 Bogota time (UTC-5)', () => {
    // Wednesday 2026-11-18 12:00 Bogota
    expect(iso(weekRangeBogota(new Date('2026-11-18T17:00:00Z')))).toEqual(['2026-11-16T05:00:00.000Z', '2026-11-23T05:00:00.000Z']);
  });

  it('keeps Sunday 23:30 Bogota in the week that ends and Monday 00:10 in the next', () => {
    expect(iso(weekRangeBogota(new Date('2026-11-23T04:30:00Z')))[0]).toBe('2026-11-16T05:00:00.000Z');
    expect(iso(weekRangeBogota(new Date('2026-11-23T05:10:00Z')))[0]).toBe('2026-11-23T05:00:00.000Z');
  });
});
