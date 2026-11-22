import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import { CreateTeacherDto } from './dto/create-teacher.dto.js';
import { ListTeachersQuery } from './dto/list-teachers.dto.js';
import { UpdateTeacherDto } from './dto/update-teacher.dto.js';
import { TeachersService } from './teachers.service.js';

@ApiTags('teachers')
@ApiBearerAuth()
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Roles('SUPERADMIN')
  @Get()
  list(@Query() query: ListTeachersQuery) {
    return this.teachers.list(query);
  }

  @Roles('SUPERADMIN')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.teachers.detail(id);
  }

  @Roles('SUPERADMIN')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTeacherDto) {
    return this.teachers.update(id, dto);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/temporary-password')
  regeneratePassword(@Param('id', ParseUUIDPipe) id: string) {
    return this.teachers.regeneratePassword(id);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.teachers.deactivate(id);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/reactivate')
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.teachers.reactivate(id);
  }

  @Roles('SUPERADMIN')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.teachers.remove(id);
  }

  @Roles('SUPERADMIN')
  @Post()
  create(@Body() dto: CreateTeacherDto) {
    return this.teachers.create(dto);
  }
}
