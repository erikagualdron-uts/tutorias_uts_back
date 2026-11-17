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
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/guards/decorators.js';
import { DropdownListsService } from './dropdown-lists.service.js';
import {
  CreateDropdownItemDto,
  ReorderDropdownItemsDto,
  UpdateDropdownItemDto,
} from './dto/dropdown-item.dto.js';

@ApiTags('dropdown-lists')
@ApiBearerAuth()
@Controller('dropdown-lists')
export class DropdownListsController {
  constructor(private readonly lists: DropdownListsService) {}

  @Roles('SUPERADMIN')
  @Get()
  all() {
    return this.lists.lists();
  }

  @Roles('SUPERADMIN')
  @Get(':key')
  detail(@Param('key') key: string) {
    return this.lists.detail(key);
  }

  // Any authenticated role: app selectors read the active items of a list.
  @Get(':key/items')
  activeItems(@Param('key') key: string) {
    return this.lists.activeItems(key);
  }

  @Roles('SUPERADMIN')
  @Post(':key/items')
  create(@Param('key') key: string, @Body() dto: CreateDropdownItemDto) {
    return this.lists.createItem(key, dto);
  }

  @Roles('SUPERADMIN')
  @Put(':key/items/order')
  reorder(@Param('key') key: string, @Body() dto: ReorderDropdownItemsDto) {
    return this.lists.reorder(key, dto.itemIds);
  }

  @Roles('SUPERADMIN')
  @Patch(':key/items/:itemId')
  update(
    @Param('key') key: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateDropdownItemDto,
  ) {
    return this.lists.updateItem(key, itemId, dto);
  }

  @Roles('SUPERADMIN')
  @HttpCode(204)
  @Delete(':key/items/:itemId')
  async remove(
    @Param('key') key: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    await this.lists.removeItem(key, itemId);
  }
}
