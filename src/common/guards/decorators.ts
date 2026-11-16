import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Role, User } from '@prisma/client';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

export const Public = () => SetMetadata(IS_PUBLIC, true);
// No @Roles means any authenticated user; with roles, only those roles.
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface AuthContext {
  user: User;
  sessionId: string;
}

export const CurrentAuth = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthContext =>
    context.switchToHttp().getRequest<{ auth: AuthContext }>().auth,
);
