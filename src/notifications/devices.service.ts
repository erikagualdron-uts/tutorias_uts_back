import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RegisterDeviceDto } from './dto/notifications.dto.js';

// Devices allowed to receive push (FR-014 to FR-016). The token is unique in the whole table, so a
// device belongs to one user: registering it again from another account moves it there.
@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  // Idempotent: the same token never creates a second row, and a discarded one comes back to life.
  async register(userId: string, sessionId: string, { token, platform }: RegisterDeviceDto): Promise<void> {
    await this.prisma.pushToken.upsert({
      where: { token },
      create: { userId, sessionId, token, platform },
      update: { userId, sessionId, platform, deletedAt: null },
    });
  }

  // Only the owner can discard it; asking again, or for an unknown token, is not an error.
  async discard(userId: string, token: string): Promise<void> {
    await this.prisma.pushToken.updateMany({
      where: { token, userId, deletedAt: null },
      data: { deletedAt: this.clock.now() },
    });
  }
}
