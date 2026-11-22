import type { NoticeFrames } from './index.js';

export const noticeEs: NoticeFrames = {
  byType: {
    MODULE_TEACHER_CHANGED: { tone: 'info', badge: 'Cambio de docente', intro: 'Hola, cambió el docente de uno de tus módulos.' },
    MODULE_ROOM_CHANGED: { tone: 'info', badge: 'Cambio de salón', intro: 'Hola, cambió el salón de uno de tus módulos.' },
    SESSIONS_CANCELLED_HOLIDAY: { tone: 'error', badge: 'Cancelada por festivo', intro: 'Hola, un festivo cancela sesiones de tus módulos.' },
    SESSIONS_RESTORED_HOLIDAY: { tone: 'success', badge: 'Restablecida', intro: 'Hola, se restablecen sesiones de tus módulos que un festivo había cancelado.' },
    SESSION_RESCHEDULED: { tone: 'warning', badge: 'Cambio de hora', intro: 'Hola, una de tus tutorías cambió de hora.' },
    SESSION_CANCELLED_TEACHER: { tone: 'error', badge: 'Cancelada', intro: 'Hola, el docente canceló una de tus tutorías.' },
    SESSION_RESTORED_TEACHER: { tone: 'success', badge: 'Reactivada', intro: 'Hola, el docente reactivó una tutoría que había cancelado.' },
    PQRS_IN_REVIEW: { tone: 'info', badge: 'PQRS en revisión', intro: 'Hola, el CAE empezó a revisar tu PQRS.' },
    PQRS_RESPONDED: { tone: 'info', badge: 'Respuesta a tu PQRS', intro: 'Hola, el CAE respondió tu PQRS.' },
    PQRS_RESOLVED: { tone: 'success', badge: 'PQRS resuelta', intro: 'Hola, el CAE resolvió tu PQRS.' },
  },
  generic: { tone: 'info', badge: 'Novedad', intro: 'Hola, hay una novedad en uno de tus módulos.' },
};
