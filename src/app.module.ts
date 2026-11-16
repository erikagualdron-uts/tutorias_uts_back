import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { ClockModule } from './common/clock.js';
import { validateEnv } from './config/env.js';
import { MailModule } from './mail/mail.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { TeachersModule } from './teachers/teachers.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ClockModule,
    PrismaModule,
    SettingsModule,
    RedisModule,
    MailModule,
    AuthModule,
    TeachersModule,
    UsersModule,
  ],
})
export class AppModule {}
