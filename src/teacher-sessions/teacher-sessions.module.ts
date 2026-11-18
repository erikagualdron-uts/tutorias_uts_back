import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PeriodsModule } from '../periods/periods.module.js';
import { TeacherScheduleService } from './teacher-schedule.service.js';
import { TeacherSessionsController } from './teacher-sessions.controller.js';
import { TeacherSessionsService } from './teacher-sessions.service.js';

@Module({
  imports: [PeriodsModule, OutboxModule],
  controllers: [TeacherSessionsController],
  providers: [TeacherSessionsService, TeacherScheduleService],
})
export class TeacherSessionsModule {}
