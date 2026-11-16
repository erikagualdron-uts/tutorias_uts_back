import { HttpException } from '@nestjs/common';

// Stable codes from specs/001-auth-roles/contracts/auth-api.yaml; the app translates them.
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'EMAIL_ALREADY_REGISTERED',
  'EMAIL_DOMAIN_NOT_ALLOWED',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'CODE_ATTEMPTS_EXCEEDED',
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_UNAVAILABLE',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'TOKEN_INVALID',
  'PASSWORD_TOO_WEAK',
  'PASSWORD_SAME_AS_CURRENT',
  'PASSWORD_CHANGE_REQUIRED',
  'FORBIDDEN_ROLE',
  'RATE_LIMITED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    // Developer-facing only: the app never shows it.
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, status);
  }
}
