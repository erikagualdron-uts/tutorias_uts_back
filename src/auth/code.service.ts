import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { VerificationPurpose } from '@prisma/client';
import { Clock } from '../common/clock.js';
import type { Env } from '../config/env.js';
import { hmacSha256, randomDigits, safeEqual } from '../common/crypto.util.js';
import { AppException } from '../common/errors/app.exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

export interface IssuedCode {
  // Undefined when the cooldown or hourly limit blocked a new code; callers answer the same either way.
  code?: string;
  resendAvailableAt: Date;
}

@Injectable()
export class CodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService<Env, true>,
    private readonly clock: Clock,
  ) {}

  async issue(
    userId: string,
    purpose: VerificationPurpose,
  ): Promise<IssuedCode> {
    const now = this.clock.now();
    const cooldown = await this.settings.get('auth.resendCooldownSeconds');
    const maxPerHour = await this.settings.get('auth.resendMaxPerHour');
    const hourAgo = new Date(now.getTime() - 3_600_000);

    const recent = await this.prisma.verificationCode.findMany({
      where: { userId, purpose, createdAt: { gt: hourAgo } },
      orderBy: { createdAt: 'desc' },
    });
    const cooldownEnds =
      recent[0] && new Date(recent[0].createdAt.getTime() + cooldown * 1000);
    if (cooldownEnds && cooldownEnds > now)
      return { resendAvailableAt: cooldownEnds };
    if (recent.length >= maxPerHour) {
      return {
        resendAvailableAt: new Date(
          recent[recent.length - 1].createdAt.getTime() + 3_600_000,
        ),
      };
    }

    const code = randomDigits(6);
    const ttlMs = await this.ttlMs(purpose);
    await this.prisma.$transaction([
      // A new code invalidates the previous one.
      this.prisma.verificationCode.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: now },
      }),
      this.prisma.verificationCode.create({
        data: {
          userId,
          purpose,
          codeHash: this.hash(code),
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        },
      }),
    ]);
    return {
      code,
      resendAvailableAt: new Date(now.getTime() + cooldown * 1000),
    };
  }

  // Marks the code as used on success; throws CODE_INVALID, CODE_EXPIRED or CODE_ATTEMPTS_EXCEEDED.
  async consume(userId: string, purpose: VerificationPurpose, code: string) {
    const now = this.clock.now();
    const maxAttempts = await this.settings.get('auth.codeMaxAttempts');
    const current = await this.prisma.verificationCode.findFirst({
      where: { userId, purpose, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!current) throw new AppException(400, 'CODE_INVALID', 'No active code');
    if (current.expiresAt <= now)
      throw new AppException(400, 'CODE_EXPIRED', 'Code expired');
    // The attempt is claimed atomically before comparing, so parallel guesses cannot exceed the limit.
    const claimed = await this.prisma.verificationCode.updateMany({
      where: { id: current.id, attempts: { lt: maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0)
      throw new AppException(
        400,
        'CODE_ATTEMPTS_EXCEEDED',
        'Too many attempts',
      );
    if (!safeEqual(current.codeHash, this.hash(code)))
      throw new AppException(400, 'CODE_INVALID', 'Wrong code');
    // updateMany keeps a code single-use even with concurrent requests.
    const { count } = await this.prisma.verificationCode.updateMany({
      where: { id: current.id, usedAt: null },
      data: { usedAt: now },
    });
    if (count === 0)
      throw new AppException(400, 'CODE_INVALID', 'Code already used');
  }

  private hash(code: string) {
    return hmacSha256(this.config.get('CODE_HMAC_SECRET'), code);
  }

  private async ttlMs(purpose: VerificationPurpose) {
    if (purpose === 'EMAIL_VERIFICATION')
      return (
        (await this.settings.get('auth.verificationCodeTtlHours')) * 3_600_000
      );
    return (await this.settings.get('auth.resetCodeTtlMinutes')) * 60_000;
  }
}
