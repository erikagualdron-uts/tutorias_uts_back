import { Injectable } from '@nestjs/common';
import type { Notification } from '@prisma/client';
import { Clock } from '../common/clock.js';
import { AppException } from '../common/errors/app.exception.js';
import { PrismaService } from '../prisma/prisma.service.js';

const view = (n: Notification) => ({
  id: n.id,
  type: n.type,
  moduleId: n.moduleId,
  pqrsId: n.pqrsId,
  title: n.title,
  body: n.body,
  readAt: n.readAt,
  createdAt: n.createdAt,
});

// The inbox of the user in the token: every query filters by `userId`, so another user's notice is
// simply not found (FR-024). Nothing is ever deleted or hidden by age.
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  // Newest first; the id breaks ties so pages never repeat or skip a notice.
  async list(userId: string, { page, limit }: { page: number; limit: number }) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return { data: rows.map(view), meta: { page, limit, total } };
  }

  async unreadCount(userId: string) {
    return { unread: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  // Idempotent: reading again keeps the first reading date (FR-011).
  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: this.clock.now() } });
    const notice = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!notice) throw new AppException(404, 'NOTIFICATION_NOT_FOUND', 'The notification does not exist');
    return view(notice);
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return { updated: count };
  }
}
