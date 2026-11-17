import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock } from '../../src/common/clock.js';
import {
  ConfigUsageService,
  type RoomUsage,
} from '../../src/config-usage/config-usage.service.js';
import { MailService, type MailJob } from '../../src/mail/mail.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { REDIS } from '../../src/redis/redis.module.js';
import { RoleProbeController } from './role-probe.controller.js';

// Captures the verification and reset codes the API would email.
export class FakeMailbox {
  readonly sent: MailJob[] = [];

  async sendCode(job: MailJob) {
    this.sent.push(job);
  }

  lastTo(email: string) {
    return [...this.sent].reverse().find((job) => job.to === email);
  }

  clear() {
    this.sent.length = 0;
  }
}

export class TestClock extends Clock {
  private offsetMs = 0;

  override now() {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number) {
    this.offsetMs += ms;
  }

  reset() {
    this.offsetMs = 0;
  }
}

// Stands in for ConfigUsageService: tests set how much "use" modules and PQRS would report.
export class FakeConfigUsage extends ConfigUsageService {
  modulesInPeriod = 0;
  roomUsage: RoomUsage = { modulesInActivePeriod: 0, modulesInUpcomingPeriods: 0, maxEnrolled: 0 };
  itemsInUse = new Set<string>();

  override countModulesInPeriod(_periodId: string) {
    return Promise.resolve(this.modulesInPeriod);
  }

  override getRoomUsage(_roomId: string) {
    return Promise.resolve(this.roomUsage);
  }

  override isDropdownItemInUse(itemId: string) {
    return Promise.resolve(this.itemsInUse.has(itemId));
  }

  reset() {
    this.modulesInPeriod = 0;
    this.roomUsage = { modulesInActivePeriod: 0, modulesInUpcomingPeriods: 0, maxEnrolled: 0 };
    this.itemsInUse.clear();
  }
}

// Ids of the rows the migration preloads ("Tipos de PQRS"); reset() restores them.
export const PQRS_LIST_ID = 'a1b2c3d4-0001-4000-8000-000000000001';
export const PQRS_ITEM_IDS = [1, 2, 3, 4].map(
  (n) => `a1b2c3d4-0002-4000-8000-00000000000${n}`,
);

export interface TestContext {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  prisma: PrismaService;
  mailbox: FakeMailbox;
  clock: TestClock;
  usage: FakeConfigUsage;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const mailbox = new FakeMailbox();
  const clock = new TestClock();
  const usage = new FakeConfigUsage();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [RoleProbeController],
  })
    .overrideProvider(MailService)
    .useValue(mailbox)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(ConfigUsageService)
    .useValue(usage)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const redis = app.get<Redis>(REDIS);

  const reset = async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE verification_codes, sessions, student_profiles, teacher_profiles, users, settings, smtp_configs CASCADE',
    );
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE rooms, locations, academic_periods CASCADE',
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM dropdown_items WHERE id NOT IN (${PQRS_ITEM_IDS.map((id) => `'${id}'`).join(',')})`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE dropdown_items SET status = 'ACTIVE', deleted_at = NULL, sort_order = right(id::text, 1)::int,
         label_es = CASE right(id::text, 1) WHEN '1' THEN 'Petición' WHEN '2' THEN 'Queja' WHEN '3' THEN 'Reclamo' ELSE 'Sugerencia' END,
         label_en = CASE right(id::text, 1) WHEN '1' THEN 'Request' WHEN '2' THEN 'Complaint' WHEN '3' THEN 'Claim' ELSE 'Suggestion' END`,
    );
    usage.reset();
    const keys = await redis.keys('login:*');
    if (keys.length) await redis.del(keys);
    mailbox.clear();
    clock.reset();
  };

  return {
    app,
    http: () => request(app.getHttpServer()),
    prisma,
    mailbox,
    clock,
    usage,
    reset,
    close: () => app.close(),
  };
}
