import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import {
  ChangeRoomDto,
  ChangeTeacherDto,
  CreateModuleDto,
  ListModulesQuery,
  ListSessionsQuery,
  ReplaceSchedulesDto,
  UpdateModuleDto,
} from './dto/module.dto.js';
import { ModulesService } from './modules.service.js';

@ApiTags('modules')
@ApiBearerAuth()
@Controller('modules')
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Roles('SUPERADMIN')
  @Post()
  create(@Body() dto: CreateModuleDto) {
    return this.modules.create(dto);
  }

  @Roles('SUPERADMIN')
  @Get()
  list(@Query() query: ListModulesQuery) {
    return this.modules.list(query);
  }

  @Roles('SUPERADMIN')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.modules.detail(id);
  }

  @Roles('SUPERADMIN')
  @Get(':id/sessions')
  sessions(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListSessionsQuery) {
    return this.modules.listSessions(id, query);
  }

  @Roles('SUPERADMIN')
  @Patch(':id/room')
  changeRoom(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeRoomDto) {
    return this.modules.changeRoom(id, dto);
  }

  @Roles('SUPERADMIN')
  @Patch(':id/teacher')
  changeTeacher(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeTeacherDto) {
    return this.modules.changeTeacher(id, dto);
  }

  @Roles('SUPERADMIN')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateModuleDto) {
    return this.modules.update(id, dto);
  }

  @Roles('SUPERADMIN')
  @Put(':id/schedules')
  replaceSchedules(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceSchedulesDto) {
    return this.modules.replaceSchedules(id, dto);
  }

  @Roles('SUPERADMIN')
  @HttpCode(204)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.modules.remove(id);
  }
}
