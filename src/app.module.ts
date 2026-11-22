import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AccountsModule } from './accounts/accounts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClockModule } from './common/clock.js';
import { ConfigUsageModule } from './config-usage/config-usage.module.js';
import { EnrollmentsModule } from './enrollments/enrollments.module.js';
import { HolidaysModule } from './holidays/holidays.module.js';
import { ModulesModule } from './modules/modules.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PeriodsModule } from './periods/periods.module.js';
import { PqrsModule } from './pqrs/pqrs.module.js';
import { RoomsModule } from './rooms/rooms.module.js';
import { validateEnv } from './config/env.js';
import { MailModule } from './mail/mail.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { StudentsModule } from './students/students.module.js';
import { TeacherSessionsModule } from './teacher-sessions/teacher-sessions.module.js';
import { TeachersModule } from './teachers/teachers.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    ClockModule,
    PrismaModule,
    SettingsModule,
    ConfigUsageModule,
    PeriodsModule,
    OutboxModule,
    ModulesModule,
    EnrollmentsModule,
    TeacherSessionsModule,
    HolidaysModule,
    RoomsModule,
    RedisModule,
    MailModule,
    NotificationsModule,
    PqrsModule,
    AuthModule,
    AccountsModule,
    TeachersModule,
    StudentsModule,
    UsersModule,
  ],
})
export class AppModule {}
