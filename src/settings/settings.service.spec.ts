import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS, SettingsService } from './settings.service.js';

describe('SettingsService', () => {
  it('falls back to the default when the key has no row', async () => {
    const prisma = { setting: { findUnique: () => Promise.resolve(null) } };
    const service = new SettingsService(prisma as never);
    expect(await service.get('pqrs.subjectMaxLength')).toBe(120);
    expect(await service.get('pqrs.descriptionMaxLength')).toBe(2000);
    expect(await service.get('pqrs.responseMaxLength')).toBe(2000);
  });

  it('prefers the stored value', async () => {
    const prisma = { setting: { findUnique: () => Promise.resolve({ value: 50 }) } };
    expect(await new SettingsService(prisma as never).get('pqrs.subjectMaxLength')).toBe(50);
  });

  it('has the chat defaults of the spec 018', () => {
    expect(SETTING_DEFAULTS['chat.messageMaxLength']).toBe(2000);
    expect(SETTING_DEFAULTS['chat.directRetentionMonths']).toBe(24);
    expect(SETTING_DEFAULTS['chat.moduleRetentionMonths']).toBe(6);
    expect(SETTING_DEFAULTS['chat.pushBurstSeconds']).toBe(60);
    expect(SETTING_DEFAULTS['chat.messageMaxLength']).toBeLessThanOrEqual(4000);
  });

  it('keeps the pqrs limits under the physical column sizes', () => {
    expect(SETTING_DEFAULTS['pqrs.subjectMaxLength']).toBeLessThanOrEqual(200);
    expect(SETTING_DEFAULTS['pqrs.descriptionMaxLength']).toBeLessThanOrEqual(4000);
    expect(SETTING_DEFAULTS['pqrs.responseMaxLength']).toBeLessThanOrEqual(4000);
  });
});
