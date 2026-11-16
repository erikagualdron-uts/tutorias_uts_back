import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { hasEmailDomain, normalizeEmail } from '../common/email.util.js';
import { AppException } from '../common/errors/app.exception.js';
import { PasswordService } from '../auth/password.service.js';
import { toUserSummary } from '../auth/user-summary.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { CreateTeacherDto } from './dto/create-teacher.dto.js';
import { TemporaryPasswordService } from './temporary-password.service.js';

@Injectable()
export class TeachersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly passwords: PasswordService,
    private readonly temporary: TemporaryPasswordService,
    private readonly clock: Clock,
  ) {}

  async create(dto: CreateTeacherDto) {
    const email = normalizeEmail(dto.email);
    if (
      !hasEmailDomain(email, await this.settings.get('auth.staffEmailDomain'))
    ) {
      throw new AppException(
        422,
        'EMAIL_DOMAIN_NOT_ALLOWED',
        'Not a staff email domain',
      );
    }
    // Soft-deleted accounts keep their email taken.
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new AppException(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'Email already registered',
      );
    }

    const temporaryPassword = this.temporary.generate();
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash: await this.passwords.hash(temporaryPassword),
        role: 'TEACHER',
        emailVerifiedAt: this.clock.now(),
        mustChangePassword: true,
        teacherProfile: {
          create: { firstName: dto.firstName, lastName: dto.lastName },
        },
      },
      include: { studentProfile: true, teacherProfile: true },
    });
    // Returned only here; only its hash is stored.
    return { user: toUserSummary(user), temporaryPassword };
  }
}
