import { Global, Module } from '@nestjs/common';
import { DropdownListsController } from './dropdown-lists/dropdown-lists.controller.js';
import { DropdownListsService } from './dropdown-lists/dropdown-lists.service.js';
import { SettingsService } from './settings.service.js';
import { SmtpController } from './smtp/smtp.controller.js';
import { SmtpService } from './smtp/smtp.service.js';

@Global()
@Module({
  controllers: [DropdownListsController, SmtpController],
  providers: [SettingsService, DropdownListsService, SmtpService],
  exports: [SettingsService],
})
export class SettingsModule {}
