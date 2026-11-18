import type { MailTemplate } from './index.js';

export const resetEs: MailTemplate = (code) => ({
  subject: 'Recupera tu contraseña - UTS Tutorías',
  text: `Tu código para restablecer la contraseña es ${code}.\n\nEscríbelo en la app junto con tu nueva contraseña. Si no lo solicitaste, ignora este mensaje.`,
});
