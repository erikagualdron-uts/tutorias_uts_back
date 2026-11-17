import { Module } from '@nestjs/common';
import { PeriodsController } from './periods.controller.js';
import { PeriodsExpiryTask } from './periods-expiry.task.js';
import { PeriodsService } from './periods.service.js';

@Module({
  controllers: [PeriodsController],
  providers: [PeriodsService, PeriodsExpiryTask],
  exports: [PeriodsService],
})
export class PeriodsModule {}
