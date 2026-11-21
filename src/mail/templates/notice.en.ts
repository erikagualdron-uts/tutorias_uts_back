import type { NoticeFrames } from './index.js';

export const noticeEn: NoticeFrames = {
  byType: {
    MODULE_TEACHER_CHANGED: { tone: 'info', intro: 'Hello, the teacher of one of your modules has changed.' },
    MODULE_ROOM_CHANGED: { tone: 'info', intro: 'Hello, the room of one of your modules has changed.' },
    SESSIONS_CANCELLED_HOLIDAY: { tone: 'error', intro: 'Hello, a holiday cancels sessions of your modules.' },
    SESSIONS_RESTORED_HOLIDAY: { tone: 'success', intro: 'Hello, sessions of your modules that a holiday had cancelled are back on.' },
    SESSION_RESCHEDULED: { tone: 'warning', intro: 'Hello, one of your sessions has a new time.' },
    SESSION_CANCELLED_TEACHER: { tone: 'error', intro: 'Hello, the teacher cancelled one of your sessions.' },
    SESSION_RESTORED_TEACHER: { tone: 'success', intro: 'Hello, the teacher reinstated a session that had been cancelled.' },
  },
  generic: { tone: 'info', intro: 'Hello, there is news about one of your modules.' },
};
