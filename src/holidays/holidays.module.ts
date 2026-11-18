import { Module } from '@nestjs/common';
import { ModulesModule } from '../modules/modules.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { HOLIDAYS_CLIENT } from './holidays-client.js';
import { HolidaysController } from './holidays.controller.js';
import { HolidaysService } from './holidays.service.js';
import { NagerHolidaysClient } from './nager-holidays.client.js';

@Module({
  imports: [ModulesModule, OutboxModule],
  controllers: [HolidaysController],
  providers: [HolidaysService, { provide: HOLIDAYS_CLIENT, useClass: NagerHolidaysClient }],
})
export class HolidaysModule {}
