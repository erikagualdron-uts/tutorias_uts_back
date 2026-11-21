import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccountStatusService } from './account-status.js';

@Module({
  imports: [AuthModule],
  providers: [AccountStatusService],
  exports: [AccountStatusService],
})
export class AccountsModule {}
