import { formatDateTime, formatRange, type Words } from './format.js';
import type { NotificationContext, Rendered, TemplateSet } from './types.js';

const words: Words = { and: 'y', fromTo: (first, last) => `del ${first} al ${last}` };
const CHECK = 'Revisa el módulo en la app.';

const dates = (c: NotificationContext) => formatRange(c.sessions.map((s) => s.at), 'es', words);
const many = (c: NotificationContext) => c.sessions.length > 1;
const scopeText = (c: NotificationContext) =>
  c.scope === 'SERIES'
    ? ' Aplica a esa sesión y a las siguientes de su horario semanal.'
    : c.scope === 'SESSION'
      ? ' Solo afecta a esa sesión.'
      : '';

const rescheduled = (c: NotificationContext): Rendered => {
  const first = c.sessions[0];
  const to = formatDateTime(first.to ?? first.at, 'es');
  return many(c)
    ? {
        title: 'Cambió la hora de tus tutorías',
        body: `${c.moduleName}: ${c.sessions.length} sesiones cambiaron de hora (${dates(c)}). La primera pasó al ${to}.${scopeText(c)} ${CHECK}`,
      }
    : {
        title: 'Cambió la hora de tu tutoría',
        body: `${c.moduleName}: la sesión del ${dates(c)} pasó al ${to}.${scopeText(c)} ${CHECK}`,
      };
};

const cancelled = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Se cancelaron tus tutorías',
        body: `${c.moduleName}: se cancelaron ${c.sessions.length} sesiones (${dates(c)}).${scopeText(c)} ${CHECK}`,
      }
    : {
        title: 'Se canceló tu tutoría',
        body: `${c.moduleName}: se canceló la sesión del ${dates(c)}.${scopeText(c)} ${CHECK}`,
      };

const restored = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Tus tutorías vuelven a darse',
        body: `${c.moduleName}: ${c.sessions.length} sesiones canceladas vuelven a darse (${dates(c)}).${scopeText(c)} ${CHECK}`,
      }
    : {
        title: 'Tu tutoría vuelve a darse',
        body: `${c.moduleName}: la sesión del ${dates(c)} vuelve a darse.${scopeText(c)} ${CHECK}`,
      };

const holidayCancelled = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Se cancelaron tutorías por festivo',
        body: `${c.moduleName}: no habrá ${c.sessions.length} sesiones por festivo (${dates(c)}). ${CHECK}`,
      }
    : {
        title: 'Se canceló una tutoría por festivo',
        body: `${c.moduleName}: no habrá sesión el ${dates(c)} por festivo. ${CHECK}`,
      };

const holidayRestored = (c: NotificationContext): Rendered =>
  many(c)
    ? {
        title: 'Vuelven tutorías que eran festivo',
        body: `${c.moduleName}: ${c.sessions.length} sesiones vuelven a darse porque ya no son festivo (${dates(c)}). ${CHECK}`,
      }
    : {
        title: 'Vuelve una tutoría que era festivo',
        body: `${c.moduleName}: la sesión del ${dates(c)} vuelve a darse porque ya no es festivo. ${CHECK}`,
      };

export const es: TemplateSet = {
  SESSION_RESCHEDULED: rescheduled,
  SESSION_CANCELLED_TEACHER: cancelled,
  SESSION_RESTORED_TEACHER: restored,
  SESSIONS_CANCELLED_HOLIDAY: holidayCancelled,
  SESSIONS_RESTORED_HOLIDAY: holidayRestored,
  MODULE_TEACHER_CHANGED: (c) => ({
    title: 'Cambió el docente de tu módulo',
    body: `${c.moduleName}: ahora lo dicta ${c.teacherName}. El cambio aplica a las próximas sesiones. ${CHECK}`,
  }),
  MODULE_ROOM_CHANGED: (c) => ({
    title: 'Cambió el salón de tu módulo',
    body: `${c.moduleName}: las próximas sesiones serán en ${c.roomName}. ${CHECK}`,
  }),
};
