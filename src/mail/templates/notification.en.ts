import type { NotificationMailTemplate } from './index.js';

export const notificationEn: NotificationMailTemplate = ({ title, body }) => ({
  subject: `${title} - UTS Tutorías`,
  text: `Hello,\n\n${body}\n\nUTS Tutorías\nInstitución Universitaria Tecnológica de Santander – UTS`,
});
