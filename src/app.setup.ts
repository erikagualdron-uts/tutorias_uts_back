import {
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { AppException } from './common/errors/app.exception.js';

// Shared by main.ts and the e2e tests so both run with the same pipes, prefix and error format.
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new AppException(400, 'VALIDATION_FAILED', 'Validation failed', {
          fields: Object.fromEntries(
            errors.map((e) => [
              e.property,
              Object.keys(e.constraints ?? {})[0] ?? 'invalid',
            ]),
          ),
        }),
    }),
  );
}
