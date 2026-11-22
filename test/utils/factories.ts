import type { Locale, OutboxEventType, Prisma, Role } from '@prisma/client';
import argon2 from 'argon2';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { TestContext } from './test-app.js';

export const TEST_PASSWORD = 'Clave1234';

interface UserOverrides {
  email?: string;
  role?: Role;
  password?: string;
  verified?: boolean;
  mustChangePassword?: boolean;
  status?: 'ACTIVE' | 'INACTIVE';
  deletedAt?: Date | null;
  locale?: Locale;
}

// Inserts a user directly so each suite can start from any account state.
export async function createUser(
  prisma: PrismaService,
  overrides: UserOverrides = {},
) {
  const { role = 'STUDENT', verified = true } = overrides;
  const domain = role === 'STUDENT' ? 'uts.edu.co' : 'correo.uts.edu.co';
  return prisma.user.create({
    data: {
      email:
        overrides.email ??
        `${role.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@${domain}`,
      passwordHash: await argon2.hash(overrides.password ?? TEST_PASSWORD),
      role,
      status: overrides.status ?? 'ACTIVE',
      emailVerifiedAt: verified ? new Date() : null,
      mustChangePassword: overrides.mustChangePassword ?? false,
      locale: overrides.locale ?? 'es',
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

let counter = 0;
const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`.slice(-8);

export function createPeriod(
  prisma: PrismaService,
  overrides: {
    name?: string;
    startsOn?: string;
    endsOn?: string;
    status?: 'UPCOMING' | 'ACTIVE' | 'CLOSED';
    deletedAt?: Date | null;
  } = {},
) {
  return prisma.academicPeriod.create({
    data: {
      name: overrides.name ?? `P-${nextId()}`,
      startsOn: new Date(`${overrides.startsOn ?? '2030-01-01'}T00:00:00Z`),
      endsOn: new Date(`${overrides.endsOn ?? '2030-06-30'}T00:00:00Z`),
      status: overrides.status ?? 'UPCOMING',
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

export function createLocation(
  prisma: PrismaService,
  overrides: { name?: string; deletedAt?: Date | null } = {},
) {
  return prisma.location.create({
    data: { name: overrides.name ?? `Sede ${nextId()}`, deletedAt: overrides.deletedAt ?? null },
  });
}

export async function createRoom(
  prisma: PrismaService,
  overrides: {
    locationId?: string;
    name?: string;
    capacity?: number;
    status?: 'ACTIVE' | 'INACTIVE';
    deletedAt?: Date | null;
  } = {},
) {
  const locationId = overrides.locationId ?? (await createLocation(prisma)).id;
  return prisma.room.create({
    data: {
      locationId,
      name: overrides.name ?? `R-${nextId()}`,
      capacity: overrides.capacity ?? 30,
      status: overrides.status ?? 'ACTIVE',
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

// ---- spec 010: teachers, modules, sessions and holidays ----

export async function createTeacher(
  prisma: PrismaService,
  overrides: UserOverrides & { firstName?: string; lastName?: string } = {},
) {
  const user = await createUser(prisma, { ...overrides, role: 'TEACHER' });
  await prisma.teacherProfile.create({
    data: {
      userId: user.id,
      firstName: overrides.firstName ?? 'Docente',
      lastName: overrides.lastName ?? `Prueba ${nextId()}`,
    },
  });
  return user;
}

export interface SlotInput {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

// Inserts a module and its weekly slots straight into the database (no overlap check in the
// service), with the denormalized columns the exclusion constraints need.
export async function createModule(
  prisma: PrismaService,
  overrides: {
    periodId?: string;
    teacherId?: string;
    roomId?: string;
    name?: string;
    schedules?: SlotInput[];
    deletedAt?: Date | null;
  } = {},
) {
  const periodId = overrides.periodId ?? (await createPeriod(prisma)).id;
  const teacherId = overrides.teacherId ?? (await createTeacher(prisma)).id;
  const roomId = overrides.roomId ?? (await createRoom(prisma)).id;
  const module = await prisma.module.create({
    data: {
      periodId,
      teacherId,
      roomId,
      name: overrides.name ?? `Módulo ${nextId()}`,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
  const slots = overrides.schedules ?? [{ dayOfWeek: 2, startMinute: 840, endMinute: 960 }];
  const schedules = [];
  for (const slot of slots) {
    schedules.push(
      await prisma.moduleSchedule.create({
        data: { moduleId: module.id, periodId, teacherId, roomId, ...slot },
      }),
    );
  }
  return { ...module, schedules };
}

export function createSession(
  prisma: PrismaService,
  overrides: {
    moduleId: string;
    scheduleId: string;
    teacherId: string;
    roomId: string;
    startsAt: Date;
    endsAt?: Date;
    status?: 'SCHEDULED' | 'RESCHEDULED' | 'CANCELLED';
    deletedAt?: Date | null;
  },
) {
  return prisma.moduleSession.create({
    data: {
      moduleId: overrides.moduleId,
      scheduleId: overrides.scheduleId,
      teacherId: overrides.teacherId,
      roomId: overrides.roomId,
      originalStartsAt: overrides.startsAt,
      startsAt: overrides.startsAt,
      endsAt: overrides.endsAt ?? new Date(overrides.startsAt.getTime() + 2 * 3_600_000),
      status: overrides.status ?? 'SCHEDULED',
      cancelReason: overrides.status === 'CANCELLED' ? 'HOLIDAY' : null,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

export function createHoliday(
  prisma: PrismaService,
  overrides: {
    date?: string;
    name?: string;
    source?: 'MANUAL' | 'IMPORTED';
    deletedAt?: Date | null;
  } = {},
) {
  return prisma.holiday.create({
    data: {
      date: new Date(`${overrides.date ?? '2030-03-04'}T00:00:00Z`),
      name: overrides.name ?? `Festivo ${nextId()}`,
      source: overrides.source ?? 'MANUAL',
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

// Signs in a fresh SUPERADMIN and returns its access token.
export async function createAdminSession(ctx: Pick<TestContext, 'prisma' | 'http'>) {
  const admin = await createUser(ctx.prisma, { role: 'SUPERADMIN' });
  const res = await ctx
    .http()
    .post('/api/v1/auth/login')
    .send({ email: admin.email, password: TEST_PASSWORD });
  return { admin, token: res.body.accessToken as string };
}

export async function createStudent(
  prisma: PrismaService,
  overrides: UserOverrides & { firstName?: string; lastName?: string } = {},
) {
  const user = await createUser(prisma, { ...overrides, role: 'STUDENT' });
  await prisma.studentProfile.create({
    data: {
      userId: user.id,
      firstName: overrides.firstName ?? 'Estudiante',
      lastName: overrides.lastName ?? `Prueba ${nextId()}`,
    },
  });
  return user;
}

export function createEnrollment(
  prisma: PrismaService,
  overrides: {
    studentId: string;
    moduleId: string;
    status?: 'ACTIVE' | 'CANCELLED';
    cancelledAt?: Date;
    effectiveUntil?: Date;
  },
) {
  const cancelled = overrides.status === 'CANCELLED';
  const cancelledAt = overrides.cancelledAt ?? (cancelled ? new Date() : null);
  return prisma.enrollment.create({
    data: {
      studentId: overrides.studentId,
      moduleId: overrides.moduleId,
      status: overrides.status ?? 'ACTIVE',
      cancelledAt,
      effectiveUntil: overrides.effectiveUntil ?? (cancelled ? cancelledAt : null),
    },
  });
}

export function createAbsence(
  prisma: PrismaService,
  overrides: { enrollmentId: string; sessionId: string; deletedAt?: Date | null },
) {
  return prisma.sessionAbsence.create({
    data: {
      enrollmentId: overrides.enrollmentId,
      sessionId: overrides.sessionId,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

// An unprocessed outbox event, as the changes of specs 010 and 012 write it.
export function createOutboxEvent(
  prisma: PrismaService,
  overrides: { type: OutboxEventType; moduleId: string; payload: Prisma.InputJsonObject; createdAt?: Date },
) {
  return prisma.outboxEvent.create({
    data: {
      type: overrides.type,
      moduleId: overrides.moduleId,
      payload: overrides.payload,
      ...(overrides.createdAt && { createdAt: overrides.createdAt }),
    },
  });
}
