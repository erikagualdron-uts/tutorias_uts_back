import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import { MailProcessor } from './mail.processor.js';
import { MAIL_QUEUE, MailService } from './mail.service.js';
import { MAIL_TRANSPORT_FACTORY, SmtpConfigService } from './smtp-config.service.js';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          host: config.get('REDIS_HOST'),
          port: Number(config.get('REDIS_PORT')),
        },
      }),
    }),
    BullModule.registerQueue({ name: MAIL_QUEUE }),
  ],
  providers: [
    MailService,
    MailProcessor,
    SmtpConfigService,
    // Tests replace this to capture messages instead of opening a connection.
    { provide: MAIL_TRANSPORT_FACTORY, useValue: nodemailer.createTransport },
  ],
  exports: [MailService, SmtpConfigService],
})
export class MailModule {}
