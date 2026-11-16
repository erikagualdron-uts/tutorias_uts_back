import type { MailTemplate } from './index.js';

export const verificationEs: MailTemplate = (code) => ({
  subject: 'Verifica tu correo - UTS Tutorías',
  text: `Tu código de verificación es ${code}.\n\nEscríbelo en la app para activar tu cuenta. Si no creaste una cuenta, ignora este mensaje.`,
});
