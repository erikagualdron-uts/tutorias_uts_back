import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { encryptAesGcm } from '../../common/crypto.util.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { Env } from '../../config/env.js';
import { MessageBuilder } from '../../mail/message.js';
import { SmtpConfigService, type SmtpView } from '../../mail/smtp-config.service.js';
import { smtpCause, type SmtpCause } from '../../mail/smtp-errors.js';
import { renderSmtpTestMail } from '../../mail/templates/index.js';
import { withLayout } from '../../mail/templates/layout.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { SaveSmtpDto } from './dto/smtp.dto.js';

// The mail server settings the CAE manages from the app (spec 014, story 6). One row; the password is
// encrypted with the server key and never leaves: not in a response, not in a log, not in an error.
@Injectable()
export class SmtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly smtp: SmtpConfigService,
    private readonly messages: MessageBuilder,
  ) {}

  get(): Promise<SmtpView> {
    return this.smtp.describe();
  }

  async save(dto: SaveSmtpDto): Promise<SmtpView> {
    const existing = await this.prisma.smtpConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const password = dto.password ?? '';
    // A saved password that can no longer be read cannot be "kept": it has to be written again.
    const unreadable = existing !== null && (await this.smtp.describe()).status === 'NEEDS_RECONFIGURATION';
    if (password === '' && (!existing || unreadable)) {
      throw new AppException(422, 'SMTP_PASSWORD_REQUIRED', 'The password is required');
    }
    const data = {
      host: dto.host,
      port: dto.port,
      user: dto.user,
      from: dto.from,
      passwordEncrypted: password === '' ? existing!.passwordEncrypted : encryptAesGcm(this.config.get('SMTP_ENCRYPTION_KEY'), password),
    };
    if (existing) await this.prisma.smtpConfig.update({ where: { id: existing.id }, data });
    else await this.prisma.smtpConfig.create({ data });
    return this.smtp.describe();
  }

  // Sends a short email to the CAE who asks and reports whether it worked. The cause is a code, never
  // the text of the server, which could carry the user or the host.
  async test(user: Pick<User, 'email' | 'locale'>): Promise<{ ok: boolean; cause: SmtpCause | null }> {
    const mail = await this.smtp.transport();
    if (!mail) throw new AppException(409, 'SMTP_NOT_CONFIGURED', 'The mail server is not configured');
    const content = withLayout(renderSmtpTestMail(user.locale));
    try {
      await mail.transport.sendMail(this.messages.build(mail.from, user.email, content));
      return { ok: true, cause: null };
    } catch (error) {
      return { ok: false, cause: smtpCause(error) };
    }
  }
}
