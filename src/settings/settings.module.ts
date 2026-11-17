import { Global, Module } from '@nestjs/common';
import { DropdownListsController } from './dropdown-lists/dropdown-lists.controller.js';
import { DropdownListsService } from './dropdown-lists/dropdown-lists.service.js';
import { SettingsService } from './settings.service.js';

@Global()
@Module({
  controllers: [DropdownListsController],
  providers: [SettingsService, DropdownListsService],
  exports: [SettingsService],
})
export class SettingsModule {}
