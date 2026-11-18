import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';

@ApiTags('teacher')
@ApiBearerAuth()
@Roles('TEACHER')
@Controller('teacher')
export class TeacherSessionsController {}
