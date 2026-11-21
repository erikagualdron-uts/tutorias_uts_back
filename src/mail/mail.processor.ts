import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MAIL_QUEUE, type MailJob } from './mail.service.js';
import { MessageBuilder } from './message.js';
import { SmtpConfigService } from './smtp-config.service.js';
import { renderMail } from './templates/index.js';

@Processor(MAIL_QUEUE)
export class MailProcessor extends WorkerHost {
  constructor(
    private readonly smtp: SmtpConfigService,
    private readonly messages: MessageBuilder,
  ) {
    super();
  }

  async process(job: Job<MailJob>): Promise<void> {
    const { to, template, locale, code, expiresAt } = job.data;
    const content = renderMail(template, locale, { code, expiresAt: new Date(expiresAt) });
    const mail = await this.smtp.transport();
    // Thrown so BullMQ retries: the CAE may save the settings before the last attempt.
    if (!mail) throw new Error('SMTP is not configured');
    await mail.transport.sendMail(this.messages.build(mail.from, to, content));
  }
}
