import { formatDateTime, formatRange, type Words } from './format.js';
import type { NotificationContext, Rendered, TemplateSet } from './types.js';

const words: Words = { and: 'and', fromTo: (first, last) => `from ${first} to ${last}` };
const CHECK = 'Check the module in the app.';
const OPEN = 'Open it in the app.';

const dates = (c: NotificationContext) => formatRange(c.sessions.map((s) => s.at), 'en', words);
const many = (c: NotificationContext) => c.sessions.length > 1;
const scopeText = (c: NotificationContext) =>
  c.scope === 'SERIES'
    ? ' This applies to that session and the following ones of its weekly schedule.'
    : c.scope === 'SESSION'
      ? ' It only affects that session.'
      : '';

const rescheduled = (c: NotificationContext): Rendered => {
  const first = c.sessions[0];
  const to = formatDateTime(first.to ?? first.at, 'en');
  return many(c)
    ? {
        title: 'The time of your sessions changed',
        body: `${c.moduleName}: ${c.sessions.length} sessions changed time (${dates(c)}). The first one moved to ${to}.${scopeText(c)} ${CHECK}`,
      }
    : {
        title: 'The time of your session changed',
        body: `${c.moduleName}: the session of ${dates(c)} moved to ${to}.${scopeText(c)} ${CHECK}`,
      };
};

const cancelled = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Your sessions were cancelled',
        body: `${c.moduleName}: ${c.sessions.length} sessions were cancelled (${dates(c)}).${scopeText(c)} ${CHECK}`,
      }
    : {
        title: 'Your session was cancelled',
        body: `${c.moduleName}: the session of ${dates(c)} was cancelled.${scopeText(c)} ${CHECK}`,
      };

const restored = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Your sessions are back on',
        body: `${c.moduleName}: ${c.sessions.length} cancelled sessions are back on (${dates(c)}).${scopeText(c)} ${CHECK}`,
      }
    : {
        title: 'Your session is back on',
        body: `${c.moduleName}: the session of ${dates(c)} is back on.${scopeText(c)} ${CHECK}`,
      };

const holidayCancelled = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Sessions cancelled for a holiday',
        body: `${c.moduleName}: there will be no sessions on ${c.sessions.length} dates because of holidays (${dates(c)}). ${CHECK}`,
      }
    : {
        title: 'A session was cancelled for a holiday',
        body: `${c.moduleName}: there is no session on ${dates(c)} because of a holiday. ${CHECK}`,
      };

const holidayRestored = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Sessions are back after a holiday change',
        body: `${c.moduleName}: ${c.sessions.length} sessions are back on because those days are no longer holidays (${dates(c)}). ${CHECK}`,
      }
    : {
        title: 'A session is back after a holiday change',
        body: `${c.moduleName}: the session of ${dates(c)} is back on because that day is no longer a holiday. ${CHECK}`,
      };

export const en: TemplateSet = {
  SESSION_RESCHEDULED: rescheduled,
  SESSION_CANCELLED_TEACHER: cancelled,
  SESSION_RESTORED_TEACHER: restored,
  SESSIONS_CANCELLED_HOLIDAY: holidayCancelled,
  SESSIONS_RESTORED_HOLIDAY: holidayRestored,
  MODULE_TEACHER_CHANGED: (c) => ({
    title: 'The teacher of your module changed',
    body: `${c.moduleName}: it is now taught by ${c.teacherName}. The change applies to the upcoming sessions. ${CHECK}`,
  }),
  MODULE_ROOM_CHANGED: (c) => ({
    title: 'The room of your module changed',
    body: `${c.moduleName}: the upcoming sessions will be in ${c.roomName}. ${CHECK}`,
  }),
  PQRS_IN_REVIEW: (c) => ({
    title: 'Your PQRS is in review',
    body: `"${c.pqrsSubject}": the CAE started reviewing it. ${OPEN}`,
  }),
  PQRS_RESPONDED: (c) => ({
    title: 'Your PQRS got a reply',
    body: `"${c.pqrsSubject}": the CAE wrote a reply. ${OPEN}`,
  }),
  PQRS_RESOLVED: (c) => ({
    title: 'Your PQRS was resolved',
    body: `"${c.pqrsSubject}": the CAE marked it as resolved. ${OPEN}`,
  }),
};
