import { Global, Injectable, Module } from '@nestjs/common';

// Injected instead of `new Date()` so the e2e tests can move time (session expiry, code TTL).
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
