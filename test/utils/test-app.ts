import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { Clock } from '../../src/common/clock.js';
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

export interface TestContext {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  prisma: PrismaService;
  mailbox: FakeMailbox;
  clock: TestClock;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestApp(): Promise<TestContext> {
  const mailbox = new FakeMailbox();
  const clock = new TestClock();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [RoleProbeController],
  })
    .overrideProvider(MailService)
    .useValue(mailbox)
    .overrideProvider(Clock)
    .useValue(clock)
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
    reset,
    close: () => app.close(),
  };
}
