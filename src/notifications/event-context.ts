import type { OutboxEventType, Prisma } from '@prisma/client';
import { BOGOTA_UTC_OFFSET_HOURS } from '../common/clock.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { attendingStudents } from './recipients.js';
import type { NotificationContext, SessionChange } from './templates/index.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface EventRow {
  type: OutboxEventType;
  moduleId: string | null;
  pqrsId: string | null;
  payload: Prisma.JsonValue;
  createdAt: Date;
}

export interface Notice {
  userId: string;
  context: NotificationContext;
}

// `skip` is a stable reason: the event is marked processed with no notices and the reason is logged.
export type Resolution = { skip: string } | { notices: Notice[] };

interface PayloadSession {
  sessionId: string;
  from?: string;
  to?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toDate = (value: unknown): Date | null => {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

function payloadSessions(payload: Prisma.JsonValue): { sessions: PayloadSession[]; scope: NotificationContext['scope'] } | null {
  if (!isObject(payload) || !Array.isArray(payload.sessions)) return null;
  const sessions = (payload.sessions as unknown[]).filter(
    (s): s is PayloadSession => isObject(s) && typeof s.sessionId === 'string',
  );
  const scope = payload.scope === 'SERIES' || payload.scope === 'SESSION' ? payload.scope : null;
  return sessions.length > 0 ? { sessions, scope } : null;
}

// The Bogota calendar day `YYYY-MM-DD` as a UTC range (Bogota is UTC-5 all year).
function bogotaDayRange(day: unknown): { from: Date; to: Date } | null {
  const match = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return {
    from: new Date(Date.UTC(year, month - 1, date, BOGOTA_UTC_OFFSET_HOURS)),
    to: new Date(Date.UTC(year, month - 1, date + 1, BOGOTA_UTC_OFFSET_HOURS)),
  };
}

const base = (moduleName: string): NotificationContext => ({
  moduleName,
  sessions: [],
  scope: null,
  teacherName: null,
  roomName: null,
  pqrsSubject: null,
});

// Reads what the event refers to and who must hear about it (research.md R-2). Nothing is written.
export async function resolveEvent(db: Db, event: EventRow): Promise<Resolution> {
  if (event.pqrsId) return resolvePqrsEvent(db, event.pqrsId);
  if (!event.moduleId) return { skip: 'MODULE_NOT_FOUND' };
  const moduleId = event.moduleId;
  const module = await db.module.findFirst({ where: { id: moduleId, deletedAt: null }, select: { name: true } });
  if (!module) return { skip: 'MODULE_NOT_FOUND' };
  const payload = isObject(event.payload) ? event.payload : {};
  const context = base(module.name);

  if (event.type === 'MODULE_TEACHER_CHANGED') {
    const teacherId = typeof payload.toTeacherId === 'string' ? payload.toTeacherId : '';
    const profile = await db.teacherProfile.findUnique({ where: { userId: teacherId }, select: { firstName: true, lastName: true } });
    if (!profile) return { skip: 'TEACHER_NOT_FOUND' };
    return notices(await attendingStudents(db, { moduleId, after: event.createdAt }), () => ({
      ...context,
      teacherName: `${profile.firstName} ${profile.lastName}`,
    }));
  }

  if (event.type === 'MODULE_ROOM_CHANGED') {
    const roomId = typeof payload.toRoomId === 'string' ? payload.toRoomId : '';
    const room = await db.room.findUnique({ where: { id: roomId }, select: { name: true, location: { select: { name: true } } } });
    if (!room) return { skip: 'ROOM_NOT_FOUND' };
    return notices(await attendingStudents(db, { moduleId, after: event.createdAt }), () => ({
      ...context,
      roomName: `${room.name} (${room.location.name})`,
    }));
  }

  return resolveSessionEvent(db, { ...event, moduleId }, payload, context);
}

async function resolveSessionEvent(
  db: Db,
  event: EventRow & { moduleId: string },
  payload: Record<string, unknown>,
  context: NotificationContext,
): Promise<Resolution> {
  const changes = new Map<string, SessionChange>();
  let scope: NotificationContext['scope'] = null;

  if (event.type === 'SESSIONS_CANCELLED_HOLIDAY' || event.type === 'SESSIONS_RESTORED_HOLIDAY') {
    const range = bogotaDayRange(payload.date);
    if (!range) return { skip: 'INVALID_PAYLOAD' };
    const sessions = await db.moduleSession.findMany({
      where: { moduleId: event.moduleId, deletedAt: null, startsAt: { gte: range.from, lt: range.to } },
      select: { id: true, startsAt: true },
    });
    for (const session of sessions) changes.set(session.id, { at: session.startsAt });
  } else {
    const named = payloadSessions(event.payload);
    if (!named) return { skip: 'INVALID_PAYLOAD' };
    scope = named.scope;
    const live = await db.moduleSession.findMany({
      where: { id: { in: named.sessions.map((s) => s.sessionId) }, moduleId: event.moduleId, deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((s) => s.id));
    for (const session of named.sessions.filter((s) => liveIds.has(s.sessionId))) {
      const from = toDate(session.from);
      const to = toDate(session.to);
      // Moved: from the old start to the new one. Cancelled: the old start. Restored: the new start.
      const at = event.type === 'SESSION_RESTORED_TEACHER' ? to : from;
      if (at) changes.set(session.sessionId, event.type === 'SESSION_RESCHEDULED' && to ? { at, to } : { at });
    }
  }
  if (changes.size === 0) return { skip: 'SESSIONS_NOT_FOUND' };

  const attending = await attendingStudents(db, { sessionIds: [...changes.keys()] });
  return notices(attending, (sessionIds) => ({
    ...context,
    scope,
    sessions: sessionIds
      .map((id) => changes.get(id))
      .filter((change): change is SessionChange => change !== undefined)
      .sort((a, b) => a.at.getTime() - b.at.getTime()),
  }));
}

function notices(attending: Map<string, string[]>, build: (sessionIds: string[]) => NotificationContext): Resolution {
  return { notices: [...attending].map(([userId, sessionIds]) => ({ userId, context: build(sessionIds) })) };
}

// The author of the PQRS is the only one who hears about it, and only while the account can sign in.
async function resolvePqrsEvent(db: Db, pqrsId: string): Promise<Resolution> {
  const pqrs = await db.pqrs.findFirst({
    where: { id: pqrsId, deletedAt: null },
    select: { subject: true, author: { select: { id: true, status: true, deletedAt: true } } },
  });
  if (!pqrs) return { skip: 'PQRS_NOT_FOUND' };
  if (pqrs.author.status !== 'ACTIVE' || pqrs.author.deletedAt) return { skip: 'AUTHOR_UNAVAILABLE' };
  return { notices: [{ userId: pqrs.author.id, context: { ...base(''), pqrsSubject: pqrs.subject } }] };
}
