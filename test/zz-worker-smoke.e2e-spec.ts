import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { MAIL_TRANSPORT_FACTORY } from '../src/mail/smtp-config.service.js';
import { PUSH_GATEWAY } from '../src/notifications/push/push-gateway.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createEnrollment, createOutboxEvent, createStudent } from './utils/factories.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, FakeMailTransport, FakePushGateway } from './utils/test-app.js';

// TEMPORARY smoke check: the real scheduler, queue and worker (no overrides) with fake push and SMTP.
describe('worker smoke', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const push = new FakePushGateway();
  const smtp = new FakeMailTransport();

  beforeAll(async () => {
    const helper = await createTestApp();
    await helper.reset();
    await helper.close();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUSH_GATEWAY)
      .useValue(push)
      .overrideProvider(MAIL_TRANSPORT_FACTORY)
      .useValue(smtp.factory)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());

  it('turns an event into a notice and delivers it with no help from the test', async () => {
    const helper = await createTestApp();
    const period = await start(helper);
    const m = await seriesModule(helper, period.id, { name: 'Smoke I' });
    const student = await createStudent(prisma);
    await createEnrollment(prisma, { studentId: student.id, moduleId: m.module.id });
    await helper.close();

    await createOutboxEvent(prisma, {
      type: 'SESSION_CANCELLED_TEACHER',
      moduleId: m.module.id,
      payload: { scope: 'SESSION', sessions: [{ sessionId: m.sessions[0][0].id, from: m.sessions[0][0].startsAt.toISOString() }] },
    });

    const deadline = Date.now() + 25_000;
    let sent = 0;
    while (Date.now() < deadline) {
      sent = await prisma.notificationDelivery.count({ where: { status: { in: ['SENT', 'SKIPPED'] } } });
      if (sent === 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const rows = await prisma.notificationDelivery.findMany({ select: { channel: true, status: true } });
    process.stderr.write('SMOKE ' + JSON.stringify(rows) + ' mails=' + smtp.sent.length + '\n');
    expect(await prisma.notification.count({ where: { userId: student.id } })).toBe(1);
    expect(smtp.sent).toHaveLength(1);
    expect(rows.find((r) => r.channel === 'EMAIL')?.status).toBe('SENT');
    expect(rows.find((r) => r.channel === 'PUSH')?.status).toBe('SKIPPED');
  }, 60_000);
});
