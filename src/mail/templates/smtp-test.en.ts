import type { MailContent } from './layout.js';

export const smtpTestEn: MailContent = {
  subject: 'Email test - UTS Tutorías',
  title: 'Email test',
  tone: 'success',
  blocks: [{ kind: 'p', text: 'The mail server of UTS Tutorías is working. You can ignore this message.' }],
};
