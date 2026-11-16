import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import { CreateTeacherDto } from './dto/create-teacher.dto.js';
import { TeachersService } from './teachers.service.js';

@ApiTags('teachers')
@ApiBearerAuth()
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Roles('SUPERADMIN')
  @Post()
  create(@Body() dto: CreateTeacherDto) {
    return this.teachers.create(dto);
  }
}
