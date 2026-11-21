import { Injectable } from '@nestjs/common';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

// One ticket per message, in the same order. The code is stable; the text of the service never leaks.
export type PushTicket =
  | { ok: true; id: string }
  | { ok: false; error: 'DEVICE_NOT_REGISTERED' | 'PUSH_REJECTED' };

export type PushReceiptStatus = 'OK' | 'DEVICE_NOT_REGISTERED' | 'PUSH_REJECTED';

export interface PushGateway {
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  getReceipts(ids: readonly string[]): Promise<Map<string, PushReceiptStatus>>;
}

export const PUSH_GATEWAY = Symbol('PUSH_GATEWAY');

// The whole call failed (network, timeout, HTTP error): the caller retries.
export class PushUnavailableError extends Error {
  constructor() {
    super('PUSH_UNAVAILABLE');
  }
}

const BASE_URL = 'https://exp.host/--/api/v2/push';
const BATCH_SIZE = 100;
const TIMEOUT_MS = 10_000;

interface ExpoItem {
  status?: string;
  id?: string;
  details?: { error?: string };
}

const classify = (item: ExpoItem) => (item.details?.error === 'DeviceNotRegistered' ? 'DEVICE_NOT_REGISTERED' : 'PUSH_REJECTED');

// Thin client of the Expo push service (research.md R-5); only the two calls the feature needs.
@Injectable()
export class ExpoPushGateway implements PushGateway {
  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (const batch of chunk(messages, BATCH_SIZE)) {
      const items = (await this.post('send', batch.map((m) => ({ ...m, sound: 'default', channelId: 'default' })))) as ExpoItem[];
      for (const [index] of batch.entries()) {
        const item = items[index];
        tickets.push(item?.status === 'ok' && item.id ? { ok: true, id: item.id } : { ok: false, error: item ? classify(item) : 'PUSH_REJECTED' });
      }
    }
    return tickets;
  }

  async getReceipts(ids: readonly string[]): Promise<Map<string, PushReceiptStatus>> {
    const result = new Map<string, PushReceiptStatus>();
    for (const batch of chunk(ids, BATCH_SIZE)) {
      const items = (await this.post('getReceipts', { ids: batch })) as Record<string, ExpoItem>;
      for (const [id, item] of Object.entries(items ?? {})) {
        result.set(id, item.status === 'ok' ? 'OK' : classify(item));
      }
    }
    return result;
  }

  private async post(path: 'send' | 'getReceipts', body: unknown): Promise<unknown> {
    try {
      const response = await fetch(`${BASE_URL}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new PushUnavailableError();
      return ((await response.json()) as { data?: unknown }).data;
    } catch {
      throw new PushUnavailableError();
    }
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
