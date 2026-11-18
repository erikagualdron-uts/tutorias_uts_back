import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Roles, type AuthContext } from '../common/guards/decorators.js';
import { TeacherModulesQueryDto, TeacherSessionsQueryDto } from './dto/teacher-sessions.dto.js';
import { TeacherScheduleService } from './teacher-schedule.service.js';

// The teacher is always the token's user, never a parameter: another teacher's session is a 404.
@ApiTags('teacher')
@ApiBearerAuth()
@Roles('TEACHER')
@Controller('teacher')
export class TeacherSessionsController {
  constructor(private readonly schedule: TeacherScheduleService) {}

  @Get('modules')
  modules(@CurrentAuth() { user }: AuthContext, @Query() query: TeacherModulesQueryDto) {
    return this.schedule.modules(user.id, query);
  }

  @Get('sessions')
  sessions(@CurrentAuth() { user }: AuthContext, @Query() query: TeacherSessionsQueryDto) {
    return this.schedule.sessions(user.id, query);
  }
}
