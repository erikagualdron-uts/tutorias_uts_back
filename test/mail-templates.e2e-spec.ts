import type { Job } from 'bullmq';
import { OutboxEventType } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailProcessor } from '../src/mail/mail.processor.js';
import type { MailJob } from '../src/mail/mail.service.js';
import { DeliveriesService } from '../src/notifications/deliveries.service.js';
import { createEnrollment, createLocation, createOutboxEvent, createRoom, createStudent, createTeacher } from './utils/factories.js';
import { seriesModule, start } from './utils/teacher-fixture.js';
import { createTestApp, type SentMail, type TestContext } from './utils/test-app.js';

const BRAND = 'Institución Universitaria Tecnológica de Santander – UTS';
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
// What a reader sees in the html: no tags, entities decoded, white space collapsed.
const readable = (html: string) =>
  html
    .replace(/<title>.*?<\/title>/, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, ' ');
const flat = (text: string) => text.replace(/\s+/g, ' ');

// Spec 015: every email the API sends arrives once, branded, with its logo and in the language of its
// reader, and its plain text says what the html says.
describe('email templates: delivery of every kind', () => {
  let ctx: TestContext;
  let deliveries: DeliveriesService;

  beforeAll(async () => {
    ctx = await createTestApp();
    deliveries = ctx.app.get(DeliveriesService);
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  function expectBranded(mail: SentMail) {
    expect(mail.html).toContain('cid:uts-logo');
    expect(mail.attachments?.[0]).toMatchObject({ cid: 'uts-logo' });
    expect(mail.text).toContain(BRAND);
    // The badge is "[Text]" in the plain text and the same text in capitals in the html.
    for (const paragraph of mail.text.split('\n\n')) {
      const badge = /^\[(.+)\]$/.exec(paragraph);
      expect(readable(mail.html!)).toContain(badge ? badge[1].toUpperCase() : flat(paragraph));
    }
  }

  it('sends the seven notice types once each, in the language of each student', async () => {
    const period = await start(ctx);
    const m = await seriesModule(ctx, period.id, { name: 'Cálculo I' });
    const students = [await createStudent(ctx.prisma, { locale: 'es' }), await createStudent(ctx.prisma, { locale: 'en' })];
    for (const student of students) await createEnrollment(ctx.prisma, { studentId: student.id, moduleId: m.module.id });
    const teacher = await createTeacher(ctx.prisma);
    const room = await createRoom(ctx.prisma, { name: 'Sala 204', locationId: (await createLocation(ctx.prisma, { name: 'Sede Principal' })).id });
    const session = m.sessions[0][0];
    const named = { scope: 'SESSION', sessions: [{ sessionId: session.id, from: session.startsAt.toISOString() }] };
    const payloads: Record<OutboxEventType, object> = {
      MODULE_TEACHER_CHANGED: { fromTeacherId: m.teacher.user.id, toTeacherId: teacher.id, enrolled: 2 },
      MODULE_ROOM_CHANGED: { fromRoomId: m.room.id, toRoomId: room.id, enrolled: 2 },
      SESSIONS_CANCELLED_HOLIDAY: { date: '2030-01-08', sessions: 1 },
      SESSIONS_RESTORED_HOLIDAY: { date: '2030-01-08', restored: 1, generated: 0 },
      SESSION_RESCHEDULED: { ...named, sessions: [{ ...named.sessions[0], to: new Date(session.startsAt.getTime() + 86_400_000).toISOString() }] },
      SESSION_CANCELLED_TEACHER: named,
      SESSION_RESTORED_TEACHER: { ...named, sessions: [{ sessionId: session.id, to: session.startsAt.toISOString() }] },
    };
    for (const type of Object.values(OutboxEventType)) await createOutboxEvent(ctx.prisma, { type, moduleId: m.module.id, payload: payloads[type] as never });
    await ctx.runOutbox();

    const pending = await ctx.prisma.notificationDelivery.findMany({ where: { channel: 'EMAIL' } });
    for (const delivery of pending) await deliveries.deliverEmail(delivery.id);
    for (const delivery of pending) await deliveries.deliverEmail(delivery.id);

    for (const student of students) {
      const mails = ctx.smtp.to(student.email);
      expect(mails).toHaveLength(7);
      expect(new Set(mails.map((mail) => mail.subject)).size).toBe(7);
      mails.forEach(expectBranded);
      const greeting = student.locale === 'es' ? 'Hola, ' : 'Hello, ';
      for (const mail of mails) expect(mail.text).toContain(greeting);
    }
  });

  it('sends the verification and the reset code once each, in Spanish and in English', async () => {
    const processor = ctx.app.get(MailProcessor);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const locale of ['es', 'en'] as const) {
      for (const template of ['verification', 'reset'] as const) {
        const job: MailJob = { to: `${template}-${locale}@uts.edu.co`, template, locale, code: '123456', expiresAt };
        await processor.process({ data: job } as Job<MailJob>);
        const mails = ctx.smtp.to(job.to);
        expect(mails).toHaveLength(1);
        expectBranded(mails[0]);
        expect(mails[0].html).toContain('>123456</td>');
        expect(mails[0].subject).not.toContain('123456');
      }
    }
    expect(new Set(ctx.smtp.sent.map((mail) => mail.subject)).size).toBe(4);
  });
});
