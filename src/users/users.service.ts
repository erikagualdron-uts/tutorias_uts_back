import { Injectable } from '@nestjs/common';
import type { UserStatus } from '@prisma/client';
import { SessionService } from '../auth/session.service.js';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';

// Account state changes for the future admin features. Rows are never deleted (D-025).
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
  ) {}

  async setStatus(userId: string, status: UserStatus) {
    await this.prisma.user.update({ where: { id: userId }, data: { status } });
    if (status === 'INACTIVE') await this.sessions.revokeAllForUser(userId);
  }

  async softDelete(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: this.clock.now() },
    });
    await this.sessions.revokeAllForUser(userId);
  }
}
