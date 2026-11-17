import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';

@ApiTags('student')
@ApiBearerAuth()
@Roles('STUDENT')
@Controller('student')
export class EnrollmentsController {}
