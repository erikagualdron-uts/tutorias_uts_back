import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Roles, type AuthContext } from '../common/guards/decorators.js';
import { RescheduleDto, TeacherModulesQueryDto, TeacherSessionsQueryDto } from './dto/teacher-sessions.dto.js';
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

  @Post('sessions/:id/reschedule')
  @HttpCode(200)
  reschedule(
    @CurrentAuth() { user }: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleDto,
  ) {
    return this.changes.reschedule(user.id, id, dto);
  }
}
