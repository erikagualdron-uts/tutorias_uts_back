import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import { CreateModuleDto } from './dto/module.dto.js';
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
}
