import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { normalizeEmail } from '../common/email.util.js';
import { AppException } from '../common/errors/app.exception.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CodeService } from './code.service.js';
import type { ResetPasswordDto } from './dto/registration.dto.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly passwords: PasswordService,
    private readonly codes: CodeService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly clock: Clock,
  ) {}

  // Same answer whether or not the account exists; only active accounts get a code.
  async forgot(rawEmail: string) {
    const user = await this.activeUser(rawEmail);
    if (user) {
      const { code, expiresAt, resendAvailableAt } = await this.codes.issue(
        user.id,
        'PASSWORD_RESET',
      );
      if (code && expiresAt)
        await this.mail.sendCode({
          to: user.email,
          template: 'reset',
          locale: user.locale,
          code,
          expiresAt: expiresAt.toISOString(),
        });
      return { resendAvailableAt };
    }
    const cooldown = await this.settings.get('auth.resendCooldownSeconds');
    return {
      resendAvailableAt: new Date(this.clock.now().getTime() + cooldown * 1000),
    };
  }

  async reset({ email, code, newPassword }: ResetPasswordDto) {
    // Checked first so a weak password does not burn the code.
    await this.passwords.assertPolicy(newPassword);
    const user = await this.activeUser(email);
    if (!user) throw new AppException(400, 'CODE_INVALID', 'No active code');

    await this.codes.consume(user.id, 'PASSWORD_RESET', code);
    // The code proves control of the mailbox: verifies the email and lifts the temporary-password block.
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(newPassword),
        emailVerifiedAt: user.emailVerifiedAt ?? this.clock.now(),
        mustChangePassword: false,
      },
    });
    await this.sessions.revokeAllForUser(user.id);
  }

  private async activeUser(rawEmail: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(rawEmail) },
    });
    return user && !user.deletedAt && user.status === 'ACTIVE' ? user : null;
  }
}
