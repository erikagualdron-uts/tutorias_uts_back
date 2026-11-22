import type { ConfigService } from '@nestjs/config';
import type { VerificationPurpose } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../common/clock.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { CodeService } from './code.service.js';

const now = new Date('2026-11-21T15:00:00Z');
const settings = {
  get: (key: string) =>
    Promise.resolve(
      ({
        'auth.resendCooldownSeconds': 60,
        'auth.resendMaxPerHour': 5,
        'auth.verificationCodeTtlHours': 24,
        'auth.resetCodeTtlMinutes': 15,
      })[key],
    ),
} as unknown as SettingsService;
const prisma = {
  verificationCode: { findMany: () => Promise.resolve([]), updateMany: () => ({}), create: () => ({}) },
  $transaction: () => Promise.resolve([]),
} as unknown as PrismaService;
const service = new CodeService(prisma, settings, { get: () => 'secret' } as unknown as ConfigService<never, true>, { now: () => now } as Clock);

describe('CodeService.issue', () => {
  it.each([
    ['EMAIL_VERIFICATION', 24 * 60 * 60_000],
    ['PASSWORD_RESET', 15 * 60_000],
  ] as [VerificationPurpose, number][])('returns when the %s code expires, from the configured lifetime', async (purpose, ttlMs) => {
    const issued = await service.issue('user-id', purpose);
    expect(issued.expiresAt).toEqual(new Date(now.getTime() + ttlMs));
    expect(issued.code).toMatch(/^\d{6}$/);
  });
});
