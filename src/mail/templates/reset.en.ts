import type { MailTemplate } from './index.js';

export const resetEn: MailTemplate = (code) => ({
  subject: 'Reset your password - UTS Tutorías',
  text: `Your password reset code is ${code}.\n\nEnter it in the app together with your new password. If you did not request it, ignore this message.`,
});
