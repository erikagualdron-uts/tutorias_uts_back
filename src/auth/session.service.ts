import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Session, User } from '@prisma/client';
import { Clock } from '../common/clock.js';
import type { Env } from '../config/env.js';
import { hmacSha256, randomToken } from '../common/crypto.util.js';
import { AppException } from '../common/errors/app.exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

export type SessionWithUser = Session & { user: User };

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService<Env, true>,
    private readonly clock: Clock,
  ) {}

  async create(userId: string, deviceLabel?: string) {
    const refreshToken = randomToken(32);
    const now = this.clock.now();
    const session = await this.prisma.session.create({
      data: {
        userId,
        deviceLabel,
        refreshTokenHash: this.hash(refreshToken),
        lastUsedAt: now,
        expiresAt: await this.expiryFrom(now),
      },
    });
    return { session, refreshToken };
  }

  // Rotates the refresh token. A token that was already rotated revokes the session (possible theft).
  async rotate(refreshToken: string) {
    const hash = this.hash(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: { user: true },
    });
    if (!session) {
      await this.prisma.session.updateMany({
        where: { previousRefreshTokenHash: hash, revokedAt: null },
        data: { revokedAt: this.clock.now() },
      });
      throw new AppException(
        401,
        'SESSION_REVOKED',
        'Unknown or reused refresh token',
      );
    }
    this.assertUsable(session);

    const now = this.clock.now();
    const newToken = randomToken(32);
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: hash },
      data: {
        refreshTokenHash: this.hash(newToken),
        previousRefreshTokenHash: hash,
        lastUsedAt: now,
        expiresAt: await this.expiryFrom(now),
      },
    });
    if (count === 0)
      throw new AppException(
        401,
        'SESSION_REVOKED',
        'Refresh token already rotated',
      );
    return { session, refreshToken: newToken };
  }

  // Used on every authenticated request so disabling an account takes effect immediately.
  async validate(sessionId: string, userId: string): Promise<SessionWithUser> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
      include: { user: true },
    });
    if (!session)
      throw new AppException(401, 'TOKEN_INVALID', 'Session not found');
    this.assertUsable(session);
    return session;
  }

  revoke(sessionId: string) {
    return this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
  }

  revokeAllForUser(userId: string) {
    return this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
  }

  private assertUsable(session: SessionWithUser) {
    if (session.user.deletedAt)
      throw new AppException(401, 'ACCOUNT_UNAVAILABLE', 'Account deleted');
    if (session.user.status !== 'ACTIVE')
      throw new AppException(401, 'ACCOUNT_DISABLED', 'Account disabled');
    if (session.revokedAt)
      throw new AppException(401, 'SESSION_REVOKED', 'Session revoked');
    if (session.expiresAt <= this.clock.now())
      throw new AppException(401, 'SESSION_EXPIRED', 'Session expired');
  }

  private hash(token: string) {
    // Prefix separates this use of the secret from JWT signing.
    return hmacSha256(this.config.get('JWT_SECRET'), `refresh-token:${token}`);
  }

  private async expiryFrom(from: Date) {
    const days = await this.settings.get('auth.sessionInactivityDays');
    return new Date(from.getTime() + days * 86_400_000);
  }
}
