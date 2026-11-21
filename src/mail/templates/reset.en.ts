import { formatDateTime } from '../../notifications/templates/format.js';
import type { MailTemplate } from './index.js';

export const resetEn: MailTemplate = ({ code, expiresAt }) => ({
  subject: 'Reset your password - UTS Tutorías',
  title: 'Reset your password',
  tone: 'info',
  blocks: [
    { kind: 'p', text: 'Enter this code in the app together with your new password:' },
    { kind: 'code', text: code },
    { kind: 'p', text: `The code expires on ${formatDateTime(expiresAt, 'en')} (Bogotá time).` },
    { kind: 'p', text: 'Nobody at UTS will ask you for your password or this code. If you did not request it, ignore this message.' },
  ],
});
