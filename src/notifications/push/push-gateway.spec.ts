import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushGateway, PushUnavailableError, type PushMessage } from './push-gateway.js';

const message = (n: number): PushMessage => ({ to: `ExponentPushToken[${n}]`, title: 't', body: 'b', data: { moduleId: 'm' } });
const reply = (data: unknown, ok = true) => ({ ok, json: async () => ({ data }) }) as Response;

afterEach(() => vi.restoreAllMocks());

describe('ExpoPushGateway', () => {
  it('sends in batches of 100 and keeps one ticket per message in order', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const sent = JSON.parse(init?.body as string) as unknown[];
      return reply(sent.map((_, i) => ({ status: 'ok', id: `t${i}` })));
    });
    const tickets = await new ExpoPushGateway().send(Array.from({ length: 250 }, (_, i) => message(i)));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tickets).toHaveLength(250);
    expect(tickets.every((t) => t.ok)).toBe(true);
  });

  it('maps DeviceNotRegistered and other errors to stable codes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply([
        { status: 'ok', id: 'a' },
        { status: 'error', message: 'secret text', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', message: 'other', details: { error: 'MessageRateExceeded' } },
      ]),
    );
    const tickets = await new ExpoPushGateway().send([message(1), message(2), message(3)]);
    expect(tickets).toEqual([
      { ok: true, id: 'a' },
      { ok: false, error: 'DEVICE_NOT_REGISTERED' },
      { ok: false, error: 'PUSH_REJECTED' },
    ]);
  });

  it('throws PushUnavailableError on HTTP errors, network failures and timeouts', async () => {
    const gateway = new ExpoPushGateway();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(null, false));
    await expect(gateway.send([message(1)])).rejects.toBeInstanceOf(PushUnavailableError);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    await expect(gateway.send([message(1)])).rejects.toBeInstanceOf(PushUnavailableError);
  });

  it('reads receipts by id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply({ a: { status: 'ok' }, b: { status: 'error', details: { error: 'DeviceNotRegistered' } } }),
    );
    const receipts = await new ExpoPushGateway().getReceipts(['a', 'b']);
    expect(receipts.get('a')).toBe('OK');
    expect(receipts.get('b')).toBe('DEVICE_NOT_REGISTERED');
  });

  it('never puts tokens or service text in the thrown error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(null, false));
    const error = await new ExpoPushGateway().send([message(7)]).catch((e: Error) => e);
    expect((error as Error).message).toBe('PUSH_UNAVAILABLE');
  });
});
