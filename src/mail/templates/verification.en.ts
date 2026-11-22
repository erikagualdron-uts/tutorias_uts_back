import { formatDateTime } from '../../notifications/templates/format.js';
import type { MailTemplate } from './index.js';

export const verificationEn: MailTemplate = ({ code, expiresAt }) => ({
  subject: 'Verify your email - UTS Tutorías',
  lang: 'en',
  badge: 'Account verification',
  title: 'Verify your email',
  tone: 'info',
  blocks: [
    { kind: 'p', text: 'Enter this code in the app to activate your account:' },
    { kind: 'code', text: code },
    { kind: 'note', text: `The code expires on ${formatDateTime(expiresAt, 'en')} (Bogotá time).` },
    { kind: 'p', text: 'If you did not create an account, ignore this message.' },
  ],
});
