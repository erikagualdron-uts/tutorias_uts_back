import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { NagerHolidaysClient } from './nager-holidays.client.js';

const settings: Record<string, string | number> = {
  HOLIDAYS_API_BASE_URL: 'https://holidays.example/api/v3',
  HOLIDAYS_COUNTRY: 'CO',
  HOLIDAYS_TIMEOUT_MS: 10000,
};
const client = new NagerHolidaysClient({ get: (key: string) => settings[key] } as unknown as ConfigService<Env, true>);

const answer = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
const item = (date: string, extra: object = {}) => ({ date, localName: 'Día', name: 'Day', types: ['Public'], ...extra });

afterEach(() => vi.unstubAllGlobals());

describe('NagerHolidaysClient', () => {
  it('asks only for the year and the country, with a time limit', async () => {
    const fetchMock = answer([item('2030-01-01')]);
    vi.stubGlobal('fetch', fetchMock);
    await client.fetchYear(2030);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://holidays.example/api/v3/PublicHolidays/2030/CO');
    expect(Object.keys(init.headers)).toEqual(['Accept']);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns the Spanish name by date, and falls back to the English one', async () => {
    vi.stubGlobal('fetch', answer([item('2030-12-25', { localName: ' Navidad ' }), item('2030-01-01', { localName: '' })]));
    expect(await client.fetchYear(2030)).toEqual([
      { date: '2030-01-01', name: 'Day' },
      { date: '2030-12-25', name: 'Navidad' },
    ]);
  });

  it('keeps only valid public holidays of the requested year, once per date', async () => {
    vi.stubGlobal(
      'fetch',
      answer([
        item('2030-03-25'),
        item('2030-03-25', { localName: 'Repetido' }),
        item('2031-01-01'),
        item('2030-02-30'),
        item('30/03/2030'),
        item('2030-04-01', { types: ['Observance'] }),
        item('2030-05-01', { localName: 7, name: 7 }),
        null,
      ]),
    );
    expect((await client.fetchYear(2030)).map((e) => e.date)).toEqual(['2030-03-25']);
  });

  it.each([
    ['an answer that is not a list', answer({ error: 'x' })],
    ['an empty list', answer([])],
    ['a list with nothing usable', answer([item('2031-01-01')])],
    ['a failed status', answer([item('2030-01-01')], false)],
    ['a service that is down or too slow', vi.fn().mockRejectedValue(new Error('timeout'))],
    ['an answer that is not JSON', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad')) })],
  ])('reports the service as unavailable on %s', async (_label, fetchMock) => {
    vi.stubGlobal('fetch', fetchMock);
    await expect(client.fetchYear(2030)).rejects.toMatchObject({ code: 'HOLIDAYS_IMPORT_UNAVAILABLE', status: 502 });
  });
});
