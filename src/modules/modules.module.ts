import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PeriodsModule } from '../periods/periods.module.js';
import { ModulesController } from './modules.controller.js';
import { ModulesService } from './modules.service.js';
import { SchedulesService } from './schedules.service.js';
import { SessionsGenerator } from './sessions.generator.js';

@Module({
  imports: [PeriodsModule, OutboxModule],
  controllers: [ModulesController],
  providers: [ModulesService, SchedulesService, SessionsGenerator],
  exports: [ModulesService, SchedulesService, SessionsGenerator],
})
export class ModulesModule {}
