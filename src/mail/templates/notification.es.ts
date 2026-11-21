import type { NotificationMailTemplate } from './index.js';

export const notificationEs: NotificationMailTemplate = ({ title, body }) => ({
  subject: `${title} - UTS Tutorías`,
  text: `Hola,\n\n${body}\n\nUTS Tutorías\nInstitución Universitaria Tecnológica de Santander – UTS`,
});
