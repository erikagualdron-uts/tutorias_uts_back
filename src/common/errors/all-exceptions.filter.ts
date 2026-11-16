import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { AppException, type ErrorCode } from './app.exception.js';

interface ErrorBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.toBody(exception);
    // Only the code is logged: request bodies can hold passwords, codes or tokens.
    if (body.statusCode >= 500)
      this.logger.error(
        `${body.code}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        ...(exception.details && { details: exception.details }),
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        details: { retryAfterSeconds: 60 },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        statusCode: status,
        code:
          status === 400
            ? 'VALIDATION_FAILED'
            : status === 404
              ? 'NOT_FOUND'
              : 'INTERNAL_ERROR',
        message: exception.message,
      };
    }
    return {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error',
    };
  }
}
