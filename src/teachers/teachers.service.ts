import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountStatusService } from '../accounts/account-status.js';
import { searchCondition } from '../accounts/account-search.js';
import { Clock } from '../common/clock.js';
import { hasEmailDomain, normalizeEmail } from '../common/email.util.js';
import { AppException } from '../common/errors/app.exception.js';
import { PasswordService } from '../auth/password.service.js';
import { toUserSummary } from '../auth/user-summary.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import type { CreateTeacherDto } from './dto/create-teacher.dto.js';
import type { ListTeachersQuery } from './dto/list-teachers.dto.js';
import type { UpdateTeacherDto } from './dto/update-teacher.dto.js';
import { TemporaryPasswordService } from './temporary-password.service.js';

interface TeacherRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  status: 'ACTIVE' | 'INACTIVE';
  phone: string | null;
  modules_count: number;
}

// `modulesCount` counts the teacher's live modules of the active period only.
const TEACHER_SELECT = Prisma.sql`
  SELECT u.id, p.first_name, p.last_name, u.email, u.status, p.phone,
    (SELECT count(*)::int FROM modules m
       JOIN academic_periods ap ON ap.id = m.period_id
      WHERE m.teacher_id = u.id AND m.deleted_at IS NULL
        AND ap.status = 'ACTIVE' AND ap.deleted_at IS NULL) AS modules_count
  FROM users u JOIN teacher_profiles p ON p.user_id = u.id`;

const toItem = (row: TeacherRow) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  status: row.status,
  modulesCount: row.modules_count,
});

@Injectable()
export class TeachersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly passwords: PasswordService,
    private readonly temporary: TemporaryPasswordService,
    private readonly clock: Clock,
    private readonly accounts: AccountStatusService,
  ) {}

  async list(query: ListTeachersQuery) {
    const where = Prisma.sql`u.role = 'TEACHER' AND u.deleted_at IS NULL
      AND ${query.status ? Prisma.sql`u.status = ${query.status}::user_status` : Prisma.sql`TRUE`}
      AND ${searchCondition(query.search)}`;
    const [rows, count] = await Promise.all([
      this.prisma.$queryRaw<TeacherRow[]>`
        ${TEACHER_SELECT}
        WHERE ${where}
        ORDER BY p.last_name, p.first_name, u.id
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM users u
        JOIN teacher_profiles p ON p.user_id = u.id
        WHERE ${where}`,
    ]);
    return {
      data: rows.map(toItem),
      meta: { page: query.page, limit: query.limit, total: count[0].total },
    };
  }

  async detail(id: string) {
    const rows = await this.prisma.$queryRaw<TeacherRow[]>`
      ${TEACHER_SELECT}
      WHERE u.id = ${id}::uuid AND u.role = 'TEACHER' AND u.deleted_at IS NULL`;
    if (!rows[0])
      throw new AppException(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    return { ...toItem(rows[0]), phone: rows[0].phone };
  }

  async update(id: string, dto: UpdateTeacherDto) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.teacherProfile.findFirst({
        where: { userId: id, user: { role: 'TEACHER', deletedAt: null } },
        select: { id: true },
      });
      if (!found)
        throw new AppException(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      await tx.teacherProfile.update({
        where: { userId: id },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          ...(dto.phone !== undefined && { phone: dto.phone || null }),
        },
      });
    });
    return this.detail(id);
  }

  // The new password is returned once and only its hash is stored; the old one and every open session stop working.
  async regeneratePassword(id: string) {
    const temporaryPassword = this.temporary.generate();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: { id, role: 'TEACHER', deletedAt: null },
        select: { status: true },
      });
      if (!user)
        throw new AppException(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
      if (user.status !== 'ACTIVE')
        throw new AppException(409, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true },
      });
    });
    await this.accounts.closeSessions(id);
    return { temporaryPassword };
  }

  deactivate(id: string) {
    return this.close(id, 'deactivate');
  }

  remove(id: string) {
    return this.close(id, 'delete');
  }

  async reactivate(id: string) {
    const status = await this.prisma.$transaction((tx) => this.accounts.apply(tx, id, 'TEACHER', 'reactivate'));
    return { id, status };
  }

  // Modules are not blocked (D-088): they keep existing, marked "teacher unavailable". The result
  // tells the CAE how many of the active period were affected.
  private async close(id: string, action: 'deactivate' | 'delete') {
    const status = await this.prisma.$transaction((tx) => this.accounts.apply(tx, id, 'TEACHER', action));
    await this.accounts.closeSessions(id);
    const unavailableModules = await this.prisma.module.count({
      where: { teacherId: id, deletedAt: null, period: { status: 'ACTIVE', deletedAt: null } },
    });
    return { id, status, deleted: action === 'delete', unavailableModules };
  }

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
