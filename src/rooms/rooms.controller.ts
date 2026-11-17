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
import { CreateRoomDto, ListRoomsQuery, UpdateRoomDto } from './dto/room.dto.js';
import { RoomsService } from './rooms.service.js';

@ApiTags('rooms')
@ApiBearerAuth()
@Roles('SUPERADMIN')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  list(@Query() query: ListRoomsQuery) {
    return this.rooms.list(query);
  }

  @Post()
  create(@Body() dto: CreateRoomDto) {
    return this.rooms.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.rooms.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto) {
    return this.rooms.update(id, dto);
  }

  @Get(':id/impact')
  impact(@Param('id', ParseUUIDPipe) id: string) {
    return this.rooms.impact(id);
  }

  @HttpCode(200)
  @Post(':id/deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.rooms.deactivate(id);
  }

  @HttpCode(200)
  @Post(':id/reactivate')
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.rooms.reactivate(id);
  }

  @HttpCode(204)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.rooms.remove(id);
  }
}
