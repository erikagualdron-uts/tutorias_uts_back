import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type DeliveryJob, DeliveryQueue } from './delivery-queue.js';
import { resolveEvent } from './event-context.js';
import { renderNotification } from './templates/index.js';

const BATCH = 50;
const CHANNELS = ['PUSH', 'EMAIL'] as const;
const REPEAT_LOG_MS = 60_000;

// Turns the module change events into notices (research.md R-1). One event per transaction: the
// notices, their deliveries and `processed_at` are saved together or not at all, so a restart in the
// middle repeats the whole event and the unique (event, user) index keeps it from duplicating.
@Injectable()
export class OutboxConsumer {
  private readonly logger = new Logger(OutboxConsumer.name);
  private readonly lastReported = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly queue: DeliveryQueue,
  ) {}

  // Processes up to one batch in the order the events happened; returns how many it finished.
  async run(limit = BATCH): Promise<number> {
    const pending = await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, type: true },
    });
    let finished = 0;
    for (const event of pending) {
      try {
        const jobs = await this.processOne(event.id);
        if (jobs === null) continue;
        finished += 1;
        // After the commit. If this fails, the sweep re-adds the PENDING deliveries.
        await this.queue.enqueue(jobs).catch((error: unknown) => this.report('enqueue', event.id, event.type, error));
      } catch (error) {
        // The event stays pending and is retried on the next poll; the others go on.
        this.report('process', event.id, event.type, error);
      }
    }
    return finished;
  }

  // Null when another consumer already holds or finished the event.
  private processOne(eventId: string): Promise<DeliveryJob[] | null> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM outbox_events WHERE id = ${eventId}::uuid AND processed_at IS NULL FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return null;

      const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
      const resolution = await resolveEvent(tx, event);

      if ('skip' in resolution) {
        this.logger.warn(`Event ${event.id} (${event.type}) processed without notices: ${resolution.skip}`);
      } else if (resolution.notices.length > 0) {
        const users = await tx.user.findMany({
          where: { id: { in: resolution.notices.map((n) => n.userId) } },
          select: { id: true, locale: true },
        });
        const locales = new Map(users.map((u) => [u.id, u.locale]));
        await tx.notification.createMany({
          skipDuplicates: true,
          data: resolution.notices.map(({ userId, context }) => {
            const locale = locales.get(userId) ?? 'es';
            const { title, body } = renderNotification(event.type, locale, context);
            return { userId, eventId: event.id, type: event.type, moduleId: event.moduleId, pqrsId: event.pqrsId, locale, title, body };
          }),
        });
        const created = await tx.notification.findMany({ where: { eventId: event.id }, select: { id: true } });
        await tx.notificationDelivery.createMany({
          skipDuplicates: true,
          data: created.flatMap(({ id }) => CHANNELS.map((channel) => ({ notificationId: id, channel }))),
        });
      }

      await tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: this.clock.now() } });
      return tx.notificationDelivery.findMany({
        where: { status: 'PENDING', notification: { eventId: event.id } },
        select: { id: true, channel: true },
      });
    });
  }

  // Ids and types only: never the recipients, the text of a notice or an address. The same event is
  // reported at most once a minute so a stuck event does not flood the log.
  private report(step: string, eventId: string, type: string, error: unknown) {
    const now = this.clock.now().getTime();
    if (now - (this.lastReported.get(eventId) ?? 0) < REPEAT_LOG_MS) return;
    this.lastReported.set(eventId, now);
    const name = error instanceof Error ? error.name : 'Error';
    this.logger.error(`Could not ${step} event ${eventId} (${type}): ${name}`);
  }
}
