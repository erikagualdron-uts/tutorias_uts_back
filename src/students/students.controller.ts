import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import { ListStudentsQuery } from './dto/list-students.dto.js';
import { StudentsService } from './students.service.js';

@ApiTags('students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Roles('SUPERADMIN')
  @Get()
  list(@Query() query: ListStudentsQuery) {
    return this.students.list(query);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.deactivate(id);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/reactivate')
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.reactivate(id);
  }

  @Roles('SUPERADMIN')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.remove(id);
  }

  @Roles('SUPERADMIN')
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.detail(id);
  }
}
