import type { Role } from '@prisma/client';
import argon2 from 'argon2';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

export const TEST_PASSWORD = 'Clave1234';

interface UserOverrides {
  email?: string;
  role?: Role;
  password?: string;
  verified?: boolean;
  mustChangePassword?: boolean;
  status?: 'ACTIVE' | 'INACTIVE';
  deletedAt?: Date | null;
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
