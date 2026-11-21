import type { MailContent } from './layout.js';

export const smtpTestEs: MailContent = {
  subject: 'Prueba de correo - UTS Tutorías',
  title: 'Prueba de correo',
  tone: 'success',
  blocks: [{ kind: 'p', text: 'El servidor de correo de UTS Tutorías funciona. Puedes ignorar este mensaje.' }],
};
