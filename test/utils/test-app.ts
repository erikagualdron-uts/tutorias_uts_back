import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock } from '../../src/common/clock.js';
import { AppException } from '../../src/common/errors/app.exception.js';
import {
  ConfigUsageService,
  type RoomUsage,
} from '../../src/config-usage/config-usage.service.js';
import {
  HOLIDAYS_CLIENT,
  type HolidayEntry,
  type HolidaysClient,
} from '../../src/holidays/holidays-client.js';
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
  private frozen: Date | null = null;

  override now() {
    return this.frozen ? new Date(this.frozen) : new Date(Date.now() + this.offsetMs);
  }

  // Stops time at an exact instant (the 59, 60 and 61 minute windows need to be exact).
  freezeAt(instant: Date) {
    this.frozen = instant;
  }

  advance(ms: number) {
    this.offsetMs += ms;
  }

  reset() {
    this.offsetMs = 0;
    this.frozen = null;
  }
}

// Stands in for ConfigUsageService. It delegates to the real service (modules are real rows) unless
// a test fixes a value: `modulesInPeriod`, `roomUsage`, `itemsInUse`, or the enrolled students of a
// module with `setEnrolled`; otherwise the real enrollments are counted.
export class FakeConfigUsage extends ConfigUsageService {
  modulesInPeriod: number | null = null;
  roomUsage: RoomUsage | null = null;
  itemsInUse = new Set<string>();
  private readonly enrolled = new Map<string, number>();
  private real!: ConfigUsageService;
  private db!: PrismaService;

  constructor() {
    super(null as never);
  }

  attach(prisma: PrismaService) {
    this.db = prisma;
    this.real = new ConfigUsageService(prisma);
  }

  setEnrolled(moduleId: string, count: number) {
    this.enrolled.set(moduleId, count);
  }

  override countModulesInPeriod(periodId: string) {
    return this.modulesInPeriod === null
      ? this.real.countModulesInPeriod(periodId)
      : Promise.resolve(this.modulesInPeriod);
  }

  override async getRoomUsage(roomId: string) {
    if (this.roomUsage) return this.roomUsage;
    const usage = await this.real.getRoomUsage(roomId);
    const modules = await this.db.module.findMany({
      where: { roomId, deletedAt: null },
      select: { id: true },
    });
    const counts = await Promise.all(modules.map((m) => this.countActiveEnrollments(m.id)));
    return { ...usage, maxEnrolled: Math.max(usage.maxEnrolled, ...counts) };
  }

  override countActiveEnrollments(moduleId: string) {
    const fixed = this.enrolled.get(moduleId);
    return fixed === undefined ? this.real.countActiveEnrollments(moduleId) : Promise.resolve(fixed);
  }

  override isDropdownItemInUse(itemId: string) {
    return Promise.resolve(this.itemsInUse.has(itemId));
  }

  reset() {
    this.modulesInPeriod = null;
    this.roomUsage = null;
    this.enrolled.clear();
    this.itemsInUse.clear();
  }
}

export type FakeHolidaysMode = 'ok' | 'unavailable';

// Stands in for the holidays service of the import: `entries` is what the service "answers" and
// `mode: 'unavailable'` makes it fail like a timeout or an invalid answer would.
export class FakeHolidaysClient implements HolidaysClient {
  mode: FakeHolidaysMode = 'ok';
  entries: HolidayEntry[] = [];
  readonly requestedYears: number[] = [];

  fetchYear(year: number): Promise<HolidayEntry[]> {
    this.requestedYears.push(year);
    if (this.mode === 'unavailable') {
      return Promise.reject(
        new AppException(502, 'HOLIDAYS_IMPORT_UNAVAILABLE', 'The holidays service is unavailable'),
      );
    }
    return Promise.resolve(this.entries.filter((e) => e.date.startsWith(`${year}-`)));
  }

  reset() {
    this.mode = 'ok';
    this.entries = [];
    this.requestedYears.length = 0;
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
  holidays: FakeHolidaysClient;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const mailbox = new FakeMailbox();
  const clock = new TestClock();
  const usage = new FakeConfigUsage();
  const holidays = new FakeHolidaysClient();
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
    .overrideProvider(HOLIDAYS_CLIENT)
    .useValue(holidays)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  usage.attach(prisma);
  const redis = app.get<Redis>(REDIS);

  const reset = async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE verification_codes, sessions, student_profiles, teacher_profiles, users, settings, smtp_configs CASCADE',
    );
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE rooms, locations, academic_periods, holidays CASCADE',
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
    holidays.reset();
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
    holidays,
    reset,
    close: () => app.close(),
  };
}
