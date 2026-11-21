import type { NoticeFrames } from './index.js';

export const noticeEs: NoticeFrames = {
  byType: {
    MODULE_TEACHER_CHANGED: { tone: 'info', intro: 'Hola, cambió el docente de uno de tus módulos.' },
    MODULE_ROOM_CHANGED: { tone: 'info', intro: 'Hola, cambió el salón de uno de tus módulos.' },
    SESSIONS_CANCELLED_HOLIDAY: { tone: 'error', intro: 'Hola, un festivo cancela sesiones de tus módulos.' },
    SESSIONS_RESTORED_HOLIDAY: { tone: 'success', intro: 'Hola, se restablecen sesiones de tus módulos que un festivo había cancelado.' },
    SESSION_RESCHEDULED: { tone: 'warning', intro: 'Hola, una de tus tutorías cambió de hora.' },
    SESSION_CANCELLED_TEACHER: { tone: 'error', intro: 'Hola, el docente canceló una de tus tutorías.' },
    SESSION_RESTORED_TEACHER: { tone: 'success', intro: 'Hola, el docente reactivó una tutoría que había cancelado.' },
  },
  generic: { tone: 'info', intro: 'Hola, hay una novedad en uno de tus módulos.' },
};
