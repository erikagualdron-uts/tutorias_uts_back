import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Roles, type AuthContext } from '../common/guards/decorators.js';
import {
  RescheduleDto,
  ScopeDto,
  TeacherCalendarQueryDto,
  TeacherModulesQueryDto,
  TeacherSessionsQueryDto,
} from './dto/teacher-sessions.dto.js';
import { TeacherScheduleService } from './teacher-schedule.service.js';
import { TeacherSessionsService } from './teacher-sessions.service.js';

// The teacher is always the token's user, never a parameter: another teacher's session is a 404.
@ApiTags('teacher')
@ApiBearerAuth()
@Roles('TEACHER')
@Controller('teacher')
export class TeacherSessionsController {
  constructor(
    private readonly schedule: TeacherScheduleService,
    private readonly changes: TeacherSessionsService,
  ) {}

  @Get('modules')
  modules(@CurrentAuth() { user }: AuthContext, @Query() query: TeacherModulesQueryDto) {
    return this.schedule.modules(user.id, query);
  }

  @Get('sessions')
  sessions(@CurrentAuth() { user }: AuthContext, @Query() query: TeacherSessionsQueryDto) {
    return this.schedule.sessions(user.id, query);
  }

  // Sessions of one week (past and future, any state) for the calendar; the teacher is the token's user.
  @Get('calendar')
  calendar(@CurrentAuth() { user }: AuthContext, @Query() query: TeacherCalendarQueryDto) {
    return this.schedule.calendar(user.id, query);
  }

  @Post('sessions/:id/reschedule')
  @HttpCode(200)
  reschedule(
    @CurrentAuth() { user }: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleDto,
  ) {
    return this.changes.reschedule(user.id, id, dto);
  }

  @Post('sessions/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScopeDto) {
    return this.changes.cancel(user.id, id, dto);
  }

  @Post('sessions/:id/restore')
  @HttpCode(200)
  restore(@CurrentAuth() { user }: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScopeDto) {
    return this.changes.restore(user.id, id, dto);
  }
}
