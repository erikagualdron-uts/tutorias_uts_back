import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Env } from '../config/env.js';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { PublicThrottlerGuard } from '../common/guards/public-throttler.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { AuthController } from './auth.controller.js';
import { CodeService } from './code.service.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { PasswordService } from './password.service.js';
import { AuthService } from './auth.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RegistrationService } from './registration.service.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: Number(config.get('JWT_ACCESS_TTL_SECONDS')),
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => [
        {
          ttl: Number(config.get('THROTTLE_PUBLIC_TTL_SECONDS')) * 1000,
          limit: Number(config.get('THROTTLE_PUBLIC_LIMIT')),
        },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    RegistrationService,
    PasswordResetService,
    PasswordService,
    CodeService,
    SessionService,
    LoginAttemptsService,
    { provide: APP_GUARD, useClass: PublicThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [
    PasswordService,
    CodeService,
    SessionService,
    LoginAttemptsService,
    JwtModule,
  ],
})
export class AuthModule {}
