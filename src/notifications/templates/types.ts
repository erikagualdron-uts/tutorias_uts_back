import type { OutboxEventType } from '@prisma/client';

// One session a notice talks about. `at` is the date the change is about (the old start of a moved
// session, the start of a cancelled or restored one); `to` is the new start of a moved session.
export interface SessionChange {
  at: Date;
  to?: Date;
}

// Everything a template needs, already read when the event is processed.
export interface NotificationContext {
  moduleName: string;
  // Only the sessions this student attends, oldest first.
  sessions: SessionChange[];
  scope: 'SESSION' | 'SERIES' | null;
  teacherName: string | null;
  roomName: string | null;
}

export interface Rendered {
  title: string;
  body: string;
}

export type TemplateSet = Record<OutboxEventType, (context: NotificationContext) => Rendered>;
