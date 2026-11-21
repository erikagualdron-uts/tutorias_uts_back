import { formatDateTime } from '../../notifications/templates/format.js';
import type { MailTemplate } from './index.js';

export const verificationEs: MailTemplate = ({ code, expiresAt }) => ({
  subject: 'Verifica tu correo - UTS Tutorías',
  title: 'Verifica tu correo',
  tone: 'info',
  blocks: [
    { kind: 'p', text: 'Escribe este código en la app para activar tu cuenta:' },
    { kind: 'code', text: code },
    { kind: 'p', text: `El código vence el ${formatDateTime(expiresAt, 'es')} (hora de Bogotá).` },
    { kind: 'p', text: 'Si no creaste una cuenta, ignora este mensaje.' },
  ],
});
