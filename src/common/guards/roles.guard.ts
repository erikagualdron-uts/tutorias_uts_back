import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { AppException } from '../errors/app.exception.js';
import { type AuthContext, ROLES } from './decorators.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;

    const { auth } = context
      .switchToHttp()
      .getRequest<{ auth?: AuthContext }>();
    if (!auth || !roles.includes(auth.user.role))
      throw new AppException(403, 'FORBIDDEN_ROLE', 'Role not allowed');
    return true;
  }
}
