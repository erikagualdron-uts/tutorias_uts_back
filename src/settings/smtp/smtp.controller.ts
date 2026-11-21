import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Roles, type AuthContext } from '../../common/guards/decorators.js';
import { SaveSmtpDto } from './dto/smtp.dto.js';
import { SmtpService } from './smtp.service.js';

// Only the CAE reads or changes the mail server (FR-029); the guard runs on every operation.
@ApiTags('settings')
@ApiBearerAuth()
@Roles('SUPERADMIN')
@Controller('settings/smtp')
export class SmtpController {
  constructor(private readonly smtp: SmtpService) {}

  @Get()
  get() {
    return this.smtp.get();
  }

  @Put()
  save(@Body() dto: SaveSmtpDto) {
    return this.smtp.save(dto);
  }

  // Answers 200 with the result even when the send fails: the app shows the cause.
  @Post('test')
  @HttpCode(200)
  test(@CurrentAuth() { user }: AuthContext) {
    return this.smtp.test(user);
  }
}
