import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Roles, type AuthContext } from '../common/guards/decorators.js';
import { UpdateOwnNameDto } from './dto/update-own-name.dto.js';
import { ListStudentsQuery } from './dto/list-students.dto.js';
import { StudentsService } from './students.service.js';

@ApiTags('students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Roles('STUDENT')
  @Patch('me')
  updateOwnName(@CurrentAuth() { user }: AuthContext, @Body() dto: UpdateOwnNameDto) {
    return this.students.updateOwnName(user.id, dto);
  }

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
