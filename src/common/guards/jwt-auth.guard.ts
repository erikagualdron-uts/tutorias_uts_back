import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { SessionService } from '../../auth/session.service.js';
import { AppException } from '../errors/app.exception.js';
import { type AuthContext, IS_PUBLIC } from './decorators.js';

interface AccessTokenPayload {
  sub: string;
  sid: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { auth: AuthContext }>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token)
      throw new AppException(401, 'TOKEN_INVALID', 'Missing bearer token');

    const payload = await this.jwt
      .verifyAsync<AccessTokenPayload>(token)
      .catch(() => {
        throw new AppException(
          401,
          'TOKEN_INVALID',
          'Invalid or expired token',
        );
      });
    // Loaded on every request: a disabled or deleted account loses access immediately.
    const session = await this.sessions.validate(payload.sid, payload.sub);
    request.auth = { user: session.user, sessionId: session.id };
    return true;
  }
}
