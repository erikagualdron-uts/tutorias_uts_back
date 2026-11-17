import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import {
  ChangeRoomDto,
  CreateModuleDto,
  ListModulesQuery,
  ListSessionsQuery,
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
}
