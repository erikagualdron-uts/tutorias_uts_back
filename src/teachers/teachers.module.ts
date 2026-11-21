import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TeachersController } from './teachers.controller.js';
import { TeachersService } from './teachers.service.js';
import { TemporaryPasswordService } from './temporary-password.service.js';

@Module({
  imports: [AuthModule, AccountsModule],
  controllers: [TeachersController],
  providers: [TeachersService, TemporaryPasswordService],
})
export class TeachersModule {}
