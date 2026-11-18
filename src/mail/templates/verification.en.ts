import type { MailTemplate } from './index.js';

export const verificationEn: MailTemplate = (code) => ({
  subject: 'Verify your email - UTS Tutorías',
  text: `Your verification code is ${code}.\n\nEnter it in the app to activate your account. If you did not create an account, ignore this message.`,
});
