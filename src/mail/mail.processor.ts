import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import { decryptAesGcm } from '../common/crypto.util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAIL_QUEUE, type MailJob } from './mail.service.js';
import { renderMail } from './templates/index.js';

@Processor(MAIL_QUEUE)
export class MailProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  async process(job: Job<MailJob>): Promise<void> {
    const { to, template, locale, code } = job.data;
    const { subject, text } = renderMail(template, locale, code);
    const { transport, from } = await this.smtp();
    await transport.sendMail({ from, to, subject, text });
  }

  // SmtpConfig in the database wins; environment variables are the fallback until the settings screen exists.
  private async smtp() {
    const stored = await this.prisma.smtpConfig.findFirst({
      orderBy: { updatedAt: 'desc' },
    });
    const secretKey = this.config.get('SMTP_ENCRYPTION_KEY');
    const host = stored?.host ?? this.config.get('SMTP_HOST');
    const port = stored?.port ?? this.config.get('SMTP_PORT');
    const user = stored?.user ?? this.config.get('SMTP_USER');
    const pass = stored
      ? decryptAesGcm(secretKey, stored.passwordEncrypted)
      : this.config.get('SMTP_PASSWORD');
    return {
      from: stored?.from ?? this.config.get('SMTP_FROM'),
      transport: nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        ...(user && { auth: { user, pass } }),
      }),
    };
  }
}
