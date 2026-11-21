import { formatDateTime } from '../../notifications/templates/format.js';
import type { MailTemplate } from './index.js';

export const resetEs: MailTemplate = ({ code, expiresAt }) => ({
  subject: 'Recupera tu contraseña - UTS Tutorías',
  title: 'Recupera tu contraseña',
  tone: 'info',
  blocks: [
    { kind: 'p', text: 'Escribe este código en la app junto con tu nueva contraseña:' },
    { kind: 'code', text: code },
    { kind: 'p', text: `El código vence el ${formatDateTime(expiresAt, 'es')} (hora de Bogotá).` },
    { kind: 'p', text: 'Nadie de la UTS te pedirá tu contraseña ni este código. Si no lo solicitaste, ignora este mensaje.' },
  ],
});
