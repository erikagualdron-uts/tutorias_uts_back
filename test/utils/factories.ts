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
