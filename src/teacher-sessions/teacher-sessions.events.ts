import type { Prisma } from '@prisma/client';

export type SessionScope = 'SESSION' | 'SERIES';

// Payloads of the outbox events (data-model.md): ids, dates and scope only, never data of students.
export interface Moved {
  sessionId: string;
  from: Date;
  to: Date;
}

const iso = (d: Date) => d.toISOString();

export const rescheduledPayload = (scope: SessionScope, moved: readonly Moved[]): Prisma.InputJsonObject => ({
  scope,
  sessions: moved.map((m) => ({ sessionId: m.sessionId, from: iso(m.from), to: iso(m.to) })),
});

export const cancelledPayload = (
  scope: SessionScope,
  sessions: readonly { sessionId: string; from: Date }[],
): Prisma.InputJsonObject => ({
  scope,
  sessions: sessions.map((s) => ({ sessionId: s.sessionId, from: iso(s.from) })),
});

export const restoredPayload = (
  scope: SessionScope,
  sessions: readonly { sessionId: string; to: Date }[],
): Prisma.InputJsonObject => ({
  scope,
  sessions: sessions.map((s) => ({ sessionId: s.sessionId, to: iso(s.to) })),
});
