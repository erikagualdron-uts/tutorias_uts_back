import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import { CreateTeacherDto } from './dto/create-teacher.dto.js';
import { ListTeachersQuery } from './dto/list-teachers.dto.js';
import { TeachersService } from './teachers.service.js';

@ApiTags('teachers')
@ApiBearerAuth()
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  // Read-only list for the CAE: it only exposes names and status, never contact or access data.
  @Roles('SUPERADMIN')
  @Get()
  list(@Query() query: ListTeachersQuery) {
    return this.teachers.list(query);
  }

  @Roles('SUPERADMIN')
  @Post()
  create(@Body() dto: CreateTeacherDto) {
    return this.teachers.create(dto);
  }
}
