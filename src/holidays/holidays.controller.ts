import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/guards/decorators.js';
import { HolidayDto, ImportHolidaysDto, YearQuery } from './dto/holiday.dto.js';
import { HolidaysService } from './holidays.service.js';

@ApiTags('holidays')
@ApiBearerAuth()
@Roles('SUPERADMIN')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  list(@Query() query: YearQuery) {
    return this.holidays.list(query.year);
  }

  @Get('import-preview')
  preview(@Query() query: YearQuery) {
    return this.holidays.preview(query.year);
  }

  @HttpCode(200)
  @Post('import')
  import(@Body() dto: ImportHolidaysDto) {
    return this.holidays.import(dto);
  }

  @Post()
  create(@Body() dto: HolidayDto) {
    return this.holidays.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HolidayDto) {
    return this.holidays.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.holidays.remove(id);
  }
}
