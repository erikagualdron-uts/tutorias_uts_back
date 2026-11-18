import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PeriodsService } from './periods.service.js';

// Backup for the check done on every read: closes the active period once its end date has passed.
@Injectable()
export class PeriodsExpiryTask {
  private readonly logger = new Logger(PeriodsExpiryTask.name);

  constructor(private readonly periods: PeriodsService) {}

  @Cron('*/15 * * * *')
  async closeExpiredPeriods() {
    const closed = await this.periods.closeExpired();
    if (closed > 0) this.logger.log(`Closed ${closed} expired period(s)`);
  }
}
