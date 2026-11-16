import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { hasEmailDomain, normalizeEmail } from '../common/email.util.js';
import { AppException } from '../common/errors/app.exception.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { CodeService } from './code.service.js';
import type { RegisterDto, VerifyEmailDto } from './dto/registration.dto.js';
import { PasswordService } from './password.service.js';

@Injectable()
export class RegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly passwords: PasswordService,
    private readonly codes: CodeService,
    private readonly mail: MailService,
    private readonly clock: Clock,
  ) {}

  async register(dto: RegisterDto) {
    const email = normalizeEmail(dto.email);
    if (
      !hasEmailDomain(email, await this.settings.get('auth.studentEmailDomain'))
    ) {
      throw new AppException(
        422,
        'EMAIL_DOMAIN_NOT_ALLOWED',
        'Not a student email domain',
      );
    }
    await this.passwords.assertPolicy(dto.password);

    // Hashed before looking the email up, so a new account and an unverified one take the same time.
    const passwordHash = await this.passwords.hash(dto.password);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    // A deleted account keeps its email taken (FR-025).
    if (existing?.deletedAt || existing?.emailVerifiedAt) {
      throw new AppException(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'Email already registered',
      );
    }
    // An unverified account only gets its code resent: password, names and locale stay as they were.
    const user =
      existing ??
      (await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          role: 'STUDENT',
          locale: dto.locale,
          studentProfile: {
            create: {
              firstName: dto.firstName.trim(),
              lastName: dto.lastName.trim(),
            },
          },
        },
      }));
    return this.sendCode(user);
  }

  // Same answer whether or not the account exists (no account enumeration).
  async resend(rawEmail: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(rawEmail) },
    });
    if (
      user &&
      !user.deletedAt &&
      !user.emailVerifiedAt &&
      user.status === 'ACTIVE'
    )
      return this.sendCode(user);
    const cooldown = await this.settings.get('auth.resendCooldownSeconds');
    return {
      resendAvailableAt: new Date(this.clock.now().getTime() + cooldown * 1000),
    };
  }

  async verify({ email, code }: VerifyEmailDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
    if (!user || user.deletedAt || user.emailVerifiedAt) {
      throw new AppException(400, 'CODE_INVALID', 'No active code');
    }
    await this.codes.consume(user.id, 'EMAIL_VERIFICATION', code);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: this.clock.now() },
    });
  }

  private async sendCode(user: {
    id: string;
    email: string;
    locale: 'es' | 'en';
  }) {
    const { code, resendAvailableAt } = await this.codes.issue(
      user.id,
      'EMAIL_VERIFICATION',
    );
    if (code)
      await this.mail.sendCode({
        to: user.email,
        template: 'verification',
        locale: user.locale,
        code,
      });
    return { resendAvailableAt };
  }
}
