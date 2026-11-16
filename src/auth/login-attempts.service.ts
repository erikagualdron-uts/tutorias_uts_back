import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import { SettingsService } from '../settings/settings.service.js';

@Injectable()
export class LoginAttemptsService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settings: SettingsService,
  ) {}

  // Seconds left on the lockout for this email + IP, or 0 when not locked.
  async lockedForSeconds(email: string, ip: string): Promise<number> {
    return Math.max(await this.redis.ttl(this.lockKey(email, ip)), 0);
  }

  async recordFailure(email: string, ip: string): Promise<void> {
    const windowSeconds =
      (await this.settings.get('auth.loginLockoutMinutes')) * 60;
    const failures = await this.redis.incr(this.failKey(email, ip));
    if (failures === 1)
      await this.redis.expire(this.failKey(email, ip), windowSeconds);
    if (failures >= (await this.settings.get('auth.loginMaxFailures'))) {
      await this.redis.set(this.lockKey(email, ip), '1', 'EX', windowSeconds);
      await this.redis.del(this.failKey(email, ip));
    }
  }

  async reset(email: string, ip: string): Promise<void> {
    await this.redis.del(this.failKey(email, ip), this.lockKey(email, ip));
  }

  private failKey(email: string, ip: string) {
    return `login:fail:${email}:${ip}`;
  }

  private lockKey(email: string, ip: string) {
    return `login:lock:${email}:${ip}`;
  }
}
