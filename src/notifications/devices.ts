import type { PrismaService } from '../prisma/prisma.service.js';

// The devices of a user that can still receive a push: the token is not discarded and its session is
// alive. The sign-out drops the token, this covers the sessions that only expired.
export function liveDevices(prisma: PrismaService, userId: string, now: Date) {
  return prisma.pushToken.findMany({
    where: { userId, deletedAt: null, session: { revokedAt: null, expiresAt: { gt: now } } },
    select: { id: true, token: true },
  });
}
