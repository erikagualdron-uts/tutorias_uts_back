import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

const monthsAgo = (from: Date, months: number) => {
  const date = new Date(from);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
};

// Deletes (logically) the messages past their retention: module chats 6 months, direct chats 2 years
// (docs/Context.md). Idempotent; it logs how many rows, never a text.
@Injectable()
export class ChatRetentionTask {
  private readonly logger = new Logger(ChatRetentionTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  @Cron('0 3 * * *', { timeZone: 'America/Bogota' })
  async run(): Promise<{ module: number; direct: number }> {
    const now = this.clock.now();
    const [moduleMonths, directMonths] = await Promise.all([
      this.settings.get('chat.moduleRetentionMonths'),
      this.settings.get('chat.directRetentionMonths'),
    ]);
    const expire = async (type: 'MODULE' | 'DIRECT', months: number) =>
      (
        await this.prisma.message.updateMany({
          where: { deletedAt: null, createdAt: { lt: monthsAgo(now, months) }, conversation: { type } },
          data: { deletedAt: now },
        })
      ).count;
    const result = { module: await expire('MODULE', moduleMonths), direct: await expire('DIRECT', directMonths) };
    if (result.module + result.direct > 0) this.logger.log(`Deleted ${result.module} module and ${result.direct} direct chat message(s)`);
    return result;
  }
}
