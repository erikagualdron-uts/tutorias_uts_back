import type { NoticeFrames } from './index.js';

export const noticeEn: NoticeFrames = {
  byType: {
    MODULE_TEACHER_CHANGED: { tone: 'info', badge: 'Teacher change', intro: 'Hello, the teacher of one of your modules has changed.' },
    MODULE_ROOM_CHANGED: { tone: 'info', badge: 'Room change', intro: 'Hello, the room of one of your modules has changed.' },
    SESSIONS_CANCELLED_HOLIDAY: { tone: 'error', badge: 'Cancelled for a holiday', intro: 'Hello, a holiday cancels sessions of your modules.' },
    SESSIONS_RESTORED_HOLIDAY: { tone: 'success', badge: 'Back on', intro: 'Hello, sessions of your modules that a holiday had cancelled are back on.' },
    SESSION_RESCHEDULED: { tone: 'warning', badge: 'Time change', intro: 'Hello, one of your sessions has a new time.' },
    SESSION_CANCELLED_TEACHER: { tone: 'error', badge: 'Cancelled', intro: 'Hello, the teacher cancelled one of your sessions.' },
    SESSION_RESTORED_TEACHER: { tone: 'success', badge: 'Reinstated', intro: 'Hello, the teacher reinstated a session that had been cancelled.' },
    PQRS_IN_REVIEW: { tone: 'info', badge: 'PQRS in review', intro: 'Hello, the CAE started reviewing your PQRS.' },
    PQRS_RESPONDED: { tone: 'info', badge: 'Reply to your PQRS', intro: 'Hello, the CAE replied to your PQRS.' },
    PQRS_RESOLVED: { tone: 'success', badge: 'PQRS resolved', intro: 'Hello, the CAE resolved your PQRS.' },
  },
  generic: { tone: 'info', badge: 'News', intro: 'Hello, there is news about one of your modules.' },
};
