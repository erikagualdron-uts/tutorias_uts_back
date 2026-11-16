import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Locale } from '@prisma/client';
import { Queue } from 'bullmq';

export type MailTemplateName = 'verification' | 'reset';

export interface MailJob {
  to: string;
  template: MailTemplateName;
  locale: Locale;
  code: string;
}

export const MAIL_QUEUE = 'mail';

@Injectable()
export class MailService {
  constructor(
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<MailJob>,
  ) {}

  // The job is removed once done so the code does not stay in Redis.
  async sendCode(job: MailJob): Promise<void> {
    await this.queue.add(job.template, job, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
