import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import {
  ActivatePeriodDto,
  CreatePeriodDto,
  ListPeriodsQuery,
  UpdatePeriodDto,
} from './dto/period.dto.js';
import { PeriodsService } from './periods.service.js';

@ApiTags('academic-periods')
@ApiBearerAuth()
@Controller('academic-periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Roles('SUPERADMIN')
  @Get()
  list(@Query() query: ListPeriodsQuery) {
    return this.periods.list(query);
  }

  // Any authenticated role: students see the active period when choosing modules (FR-016).
  // Declared before ':id' so "active" is not read as an id.
  @Get('active')
  active() {
    return this.periods.getActive();
  }

  @Roles('SUPERADMIN')
  @Post()
  create(@Body() dto: CreatePeriodDto) {
    return this.periods.create(dto);
  }

  @Roles('SUPERADMIN')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.periods.get(id);
  }

  @Roles('SUPERADMIN')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePeriodDto) {
    return this.periods.update(id, dto);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/activate')
  activate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ActivatePeriodDto) {
    return this.periods.activate(id, dto.confirmCloseActive);
  }

  @Roles('SUPERADMIN')
  @HttpCode(200)
  @Post(':id/close')
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.periods.close(id);
  }

  @Roles('SUPERADMIN')
  @HttpCode(204)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.periods.remove(id);
  }
}
