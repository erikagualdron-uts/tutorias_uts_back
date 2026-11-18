import { describe, expect, it } from 'vitest';
import { cancelledPayload, rescheduledPayload, restoredPayload } from './teacher-sessions.events.js';

const from = new Date('2030-01-08T19:00:00Z');
const to = new Date('2030-01-09T19:00:00Z');

describe('outbox payloads', () => {
  it('a reschedule carries scope and from/to in ISO UTC', () => {
    expect(rescheduledPayload('SERIES', [{ sessionId: 's1', from, to }])).toEqual({
      scope: 'SERIES',
      sessions: [{ sessionId: 's1', from: '2030-01-08T19:00:00.000Z', to: '2030-01-09T19:00:00.000Z' }],
    });
  });

  it('a cancellation carries only the start, a restore only the new start', () => {
    expect(cancelledPayload('SESSION', [{ sessionId: 's1', from }])).toEqual({
      scope: 'SESSION',
      sessions: [{ sessionId: 's1', from: '2030-01-08T19:00:00.000Z' }],
    });
    expect(restoredPayload('SESSION', [{ sessionId: 's1', to }])).toEqual({
      scope: 'SESSION',
      sessions: [{ sessionId: 's1', to: '2030-01-09T19:00:00.000Z' }],
    });
  });

  it('never includes anything but ids, scope and dates', () => {
    const keys = Object.keys((rescheduledPayload('SESSION', [{ sessionId: 's1', from, to }]).sessions as object[])[0]);
    expect(keys.sort((a, b) => a.localeCompare(b))).toEqual(['from', 'sessionId', 'to']);
  });
});
