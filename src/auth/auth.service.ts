import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import { AppException } from '../common/errors/app.exception.js';
import { normalizeEmail } from '../common/email.util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { toUserSummary, type UserWithProfiles } from './user-summary.js';

const WITH_PROFILES = { studentProfile: true, teacherProfile: true } as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly attempts: LoginAttemptsService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto, ip: string) {
    const email = normalizeEmail(dto.email);
    const lockedFor = await this.attempts.lockedForSeconds(email, ip);
    if (lockedFor > 0) {
      throw new AppException(429, 'RATE_LIMITED', 'Too many failed logins', {
        retryAfterSeconds: lockedFor,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: WITH_PROFILES,
    });
    const valid = await this.passwords.verify(
      user?.passwordHash ?? null,
      dto.password,
    );
    if (!user || !valid) {
      await this.attempts.recordFailure(email, ip);
      throw new AppException(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    // Account state is only revealed once the password is proven.
    if (user.deletedAt)
      throw new AppException(403, 'ACCOUNT_UNAVAILABLE', 'Account deleted');
    if (user.status !== 'ACTIVE')
      throw new AppException(403, 'ACCOUNT_DISABLED', 'Account disabled');
    if (user.role === 'STUDENT' && !user.emailVerifiedAt)
      throw new AppException(403, 'EMAIL_NOT_VERIFIED', 'Email not verified');

    await this.attempts.reset(email, ip);
    return this.openSession(user, dto.deviceLabel);
  }

  async refresh(refreshToken: string) {
    const { session, refreshToken: rotated } =
      await this.sessions.rotate(refreshToken);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: session.userId },
      include: WITH_PROFILES,
    });
    return this.tokensFor(user, session.id, rotated);
  }

  logout(sessionId: string) {
    return this.sessions.revoke(sessionId);
  }

  async changePassword(user: User, dto: ChangePasswordDto) {
    if (
      !(await this.passwords.verify(user.passwordHash, dto.currentPassword))
    ) {
      throw new AppException(
        401,
        'INVALID_CREDENTIALS',
        'Current password is wrong',
      );
    }
    await this.passwords.assertPolicy(dto.newPassword);
    if (dto.newPassword === dto.currentPassword) {
      throw new AppException(
        400,
        'PASSWORD_SAME_AS_CURRENT',
        'New password equals the current one',
      );
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(dto.newPassword),
        mustChangePassword: false,
      },
    });
  }

  async profileOf(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: WITH_PROFILES,
    });
    return toUserSummary(user);
  }

  private async openSession(user: UserWithProfiles, deviceLabel?: string) {
    const { session, refreshToken } = await this.sessions.create(
      user.id,
      deviceLabel,
    );
    return this.tokensFor(user, session.id, refreshToken);
  }

  private async tokensFor(
    user: UserWithProfiles,
    sessionId: string,
    refreshToken: string,
  ) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      sid: sessionId,
    });
    return { accessToken, refreshToken, user: toUserSummary(user) };
  }
}
