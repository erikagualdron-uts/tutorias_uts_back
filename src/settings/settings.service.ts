import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface SettingValues {
  'auth.studentEmailDomain': string;
  'auth.staffEmailDomain': string;
  'auth.passwordMinLength': number;
  'auth.sessionInactivityDays': number;
  'auth.verificationCodeTtlHours': number;
  'auth.resetCodeTtlMinutes': number;
  'auth.codeMaxAttempts': number;
  'auth.resendCooldownSeconds': number;
  'auth.resendMaxPerHour': number;
  'auth.loginMaxFailures': number;
  'auth.loginLockoutMinutes': number;
  'pqrs.subjectMaxLength': number;
  'pqrs.descriptionMaxLength': number;
  'pqrs.responseMaxLength': number;
  'dashboard.lowEnrollmentPercent': number;
  'chat.messageMaxLength': number;
  'chat.directRetentionMonths': number;
  'chat.moduleRetentionMonths': number;
  'chat.pushBurstSeconds': number;
}

export const SETTING_DEFAULTS: SettingValues = {
  'auth.studentEmailDomain': 'uts.edu.co',
  'auth.staffEmailDomain': 'correo.uts.edu.co',
  'auth.passwordMinLength': 8,
  'auth.sessionInactivityDays': 30,
  'auth.verificationCodeTtlHours': 24,
  'auth.resetCodeTtlMinutes': 60,
  'auth.codeMaxAttempts': 5,
  'auth.resendCooldownSeconds': 60,
  'auth.resendMaxPerHour': 5,
  'auth.loginMaxFailures': 5,
  'auth.loginLockoutMinutes': 15,
  'pqrs.subjectMaxLength': 120,
  'pqrs.descriptionMaxLength': 2000,
  'pqrs.responseMaxLength': 2000,
  'dashboard.lowEnrollmentPercent': 30,
  'chat.messageMaxLength': 2000,
  'chat.directRetentionMonths': 24,
  'chat.moduleRetentionMonths': 6,
  'chat.pushBurstSeconds': 60,
};

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get<K extends keyof SettingValues>(key: K): Promise<SettingValues[K]> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return (row?.value ?? SETTING_DEFAULTS[key]) as SettingValues[K];
  }
}
