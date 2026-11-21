import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SessionService } from '../auth/session.service.js';
import { Clock } from '../common/clock.js';
import { AppException } from '../common/errors/app.exception.js';

export type AccountAction = 'deactivate' | 'reactivate' | 'delete';

@Injectable()
export class AccountStatusService {
  constructor(
    private readonly clock: Clock,
    private readonly sessions: SessionService,
  ) {}

  // Repeating an action rewrites the same value. Deleted accounts and other roles are not found.
  async apply(
    tx: Prisma.TransactionClient,
    userId: string,
    role: 'TEACHER' | 'STUDENT',
    action: AccountAction,
  ) {
    const user = await tx.user.findFirst({
      where: {
        id: userId,
        role,
        deletedAt: null,
        ...(role === 'STUDENT' && { emailVerifiedAt: { not: null } }),
      },
      select: { id: true },
    });
    if (!user)
      throw new AppException(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    await tx.user.update({
      where: { id: userId },
      data:
        action === 'delete'
          ? { deletedAt: this.clock.now() }
          : { status: action === 'deactivate' ? 'INACTIVE' : 'ACTIVE' },
    });
  }

  // After the change is committed: the user loses refresh tokens and push devices.
  closeSessions(userId: string) {
    return this.sessions.revokeAllForUser(userId);
  }
}
