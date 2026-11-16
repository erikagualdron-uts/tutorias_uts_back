import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentAuth,
  Public,
  type AuthContext,
} from '../common/guards/decorators.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import {
  EmailDto,
  RegisterDto,
  VerifyEmailDto,
} from './dto/registration.dto.js';
import { RegistrationService } from './registration.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly registration: RegistrationService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(202)
  register(@Body() dto: RegisterDto) {
    return this.registration.register(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.registration.verify(dto);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(202)
  resendVerification(@Body() dto: EmailDto) {
    return this.registration.resend(dto.email);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req.ip ?? 'unknown');
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentAuth() { user }: AuthContext) {
    return this.auth.profileOf(user.id);
  }
}
