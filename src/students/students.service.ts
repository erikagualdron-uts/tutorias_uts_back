import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccountStatusService } from '../accounts/account-status.js';
import { Clock } from '../common/clock.js';
import { searchCondition } from '../accounts/account-search.js';
import { AppException } from '../common/errors/app.exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ListStudentsQuery } from './dto/list-students.dto.js';

interface StudentRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  program: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  enrolled_count: number;
}

// `enrolledCount` is the ACTIVE enrollments of the active period.
const STUDENT_SELECT = Prisma.sql`
  SELECT u.id, p.first_name, p.last_name, u.email, p.program, u.status,
    (SELECT count(*)::int FROM enrollments e
       JOIN modules m ON m.id = e.module_id
       JOIN academic_periods ap ON ap.id = m.period_id
      WHERE e.student_id = u.id AND e.status = 'ACTIVE' AND e.deleted_at IS NULL
        AND ap.status = 'ACTIVE' AND ap.deleted_at IS NULL) AS enrolled_count
  FROM users u JOIN student_profiles p ON p.user_id = u.id`;

// Only registered students: verified email and not deleted.
const BASE = Prisma.sql`u.role = 'STUDENT' AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL`;

const toItem = (row: StudentRow) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  program: row.program,
  status: row.status,
  enrolledCount: row.enrolled_count,
});

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly accounts: AccountStatusService,
  ) {}

  deactivate(id: string) {
    return this.close(id, 'deactivate');
  }

  remove(id: string) {
    return this.close(id, 'delete');
  }

  async reactivate(id: string) {
    const status = await this.prisma.$transaction((tx) => this.accounts.apply(tx, id, 'STUDENT', 'reactivate'));
    return { id, status };
  }

  // One transaction (D-092 lock order: active period shared, student row, modules by id): the ACTIVE
  // enrollments of the active period are cancelled from now on and the state changes with them, so
  // an enrollment racing the closure either commits first (and is cancelled here) or sees the state.
  private async close(id: string, action: 'deactivate' | 'delete') {
    const result = await this.prisma.$transaction(async (tx) => {
      const [period] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM academic_periods WHERE status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1 FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
      let cancelledEnrollments = 0;
      if (period) {
        const modules = await tx.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT m.id FROM enrollments e JOIN modules m ON m.id = e.module_id
          WHERE e.student_id = ${id}::uuid AND e.status = 'ACTIVE' AND e.deleted_at IS NULL
            AND m.period_id = ${period.id}::uuid
          ORDER BY m.id`;
        const moduleIds = modules.map((m) => m.id);
        if (moduleIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM modules WHERE id = ANY(${moduleIds}::uuid[]) ORDER BY id FOR UPDATE`;
          const now = this.clock.now();
          ({ count: cancelledEnrollments } = await tx.enrollment.updateMany({
            where: { studentId: id, status: 'ACTIVE', deletedAt: null, moduleId: { in: moduleIds } },
            data: { status: 'CANCELLED', cancelledAt: now, effectiveUntil: now },
          }));
        }
      }
      const status = await this.accounts.apply(tx, id, 'STUDENT', action);
      return { id, status, deleted: action === 'delete', cancelledEnrollments };
    });
    await this.accounts.closeSessions(id);
    return result;
  }

  async list(query: ListStudentsQuery) {
    const where = Prisma.sql`${BASE}
      AND ${query.status ? Prisma.sql`u.status = ${query.status}::user_status` : Prisma.sql`TRUE`}
      AND ${searchCondition(query.search)}`;
    const [rows, count] = await Promise.all([
      this.prisma.$queryRaw<StudentRow[]>`
        ${STUDENT_SELECT}
        WHERE ${where}
        ORDER BY p.last_name, p.first_name, u.id
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM users u
        JOIN student_profiles p ON p.user_id = u.id
        WHERE ${where}`,
    ]);
    return {
      data: rows.map(toItem),
      meta: { page: query.page, limit: query.limit, total: count[0].total },
    };
  }

  async detail(id: string) {
    const rows = await this.prisma.$queryRaw<StudentRow[]>`
      ${STUDENT_SELECT}
      WHERE u.id = ${id}::uuid AND ${BASE}`;
    if (!rows[0])
      throw new AppException(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    return toItem(rows[0]);
  }
}
