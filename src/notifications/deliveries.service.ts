import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DeliveryStatus } from '@prisma/client';
import { Clock } from '../common/clock.js';
import type { Env } from '../config/env.js';
import { hasEmailDomain } from '../common/email.util.js';
import { MessageBuilder } from '../mail/message.js';
import { SmtpConfigService } from '../mail/smtp-config.service.js';
import { smtpCause } from '../mail/smtp-errors.js';
import { renderNoticeMail } from '../mail/templates/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DeliveryQueue } from './delivery-queue.js';
import { PUSH_GATEWAY, PushUnavailableError, type PushGateway } from './push/push-gateway.js';

// Every device refused the message for a reason other than being gone: worth another try.
export class PushRejectedError extends Error {
  constructor() {
    super('PUSH_REJECTED');
  }
}

// The mail server refused or failed; `cause` is the stable code of the mapping, never its text.
export class EmailSendError extends Error {
  constructor(readonly cause: string) {
    super(`SMTP_${cause}`);
  }
}

// A deactivated or deleted account gets nothing, not even a notice created before it was closed (FR-013).
const unavailable = (user: { status: string; deletedAt: Date | null }) => user.status !== 'ACTIVE' || user.deletedAt !== null;

export interface ReceiptEntry {
  ticketId: string;
  token: string;
}

// Stable cause code of a failed delivery; it is stored and logged, so it never carries the text of an
// error, an address or a token (FR-022).
export function causeOf(error: unknown): string {
  if (error instanceof PushUnavailableError) return 'PUSH_UNAVAILABLE';
  if (error instanceof PushRejectedError) return 'PUSH_REJECTED';
  if (error instanceof EmailSendError) return `SMTP_${error.cause}`;
  return 'DELIVERY_ERROR';
}

// The delivery of a notice in one channel (research.md R-4 and R-5). Each method does the whole job of
// one delivery and throws when it must be retried; the worker only calls it. A delivery that is no
// longer PENDING is skipped, so a repeated job never sends twice.
@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly queue: DeliveryQueue,
    @Inject(PUSH_GATEWAY) private readonly push: PushGateway,
    private readonly smtp: SmtpConfigService,
    private readonly messages: MessageBuilder,
    private readonly settings: SettingsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Push to every live device of the recipient, with the same title and text as the notice (FR-015).
  async deliverPush(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { id: deliveryId, channel: 'PUSH', status: 'PENDING' },
      include: { notification: { include: { user: { select: { status: true, deletedAt: true } } } } },
    });
    if (!delivery) return;
    if (unavailable(delivery.notification.user)) return this.finish(delivery.id, 'SKIPPED', 'ACCOUNT_UNAVAILABLE');
    const notice = delivery.notification;
    const now = this.clock.now();
    // A device counts only while its session is alive; the sign-out drops it, this covers the rest.
    const devices = await this.prisma.pushToken.findMany({
      where: { userId: notice.userId, deletedAt: null, session: { revokedAt: null, expiresAt: { gt: now } } },
      select: { id: true, token: true },
    });
    if (devices.length === 0) return this.finish(delivery.id, 'SKIPPED', 'PUSH_NO_DEVICES');

    await this.prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { attempts: { increment: 1 } } });
    const tickets = await this.push.send(
      devices.map((device) => ({
        to: device.token,
        title: notice.title,
        body: notice.body,
        data: { notificationId: notice.id, moduleId: notice.moduleId },
      })),
    );

    const sent: ReceiptEntry[] = [];
    const gone: string[] = [];
    let rejected = 0;
    tickets.forEach((ticket, index) => {
      if (ticket.ok) sent.push({ ticketId: ticket.id, token: devices[index].token });
      else if (ticket.error === 'DEVICE_NOT_REGISTERED') gone.push(devices[index].id);
      else rejected += 1;
    });
    // A device the service says is gone is dropped and never retried (story 3, scenario 6).
    if (gone.length > 0) await this.prisma.pushToken.updateMany({ where: { id: { in: gone } }, data: { deletedAt: now } });

    if (sent.length > 0) {
      await this.finish(delivery.id, 'SENT', null);
      // Expo reports many invalid devices only in the receipts, a little later.
      await this.queue.enqueueReceipts(sent).catch(() => this.logger.warn('Could not queue the push receipts check'));
      return;
    }
    if (rejected > 0) throw new PushRejectedError();
    await this.finish(delivery.id, 'SKIPPED', 'PUSH_DEVICE_NOT_REGISTERED');
  }

  // The notice by email, in the language it was written in (FR-018). Nothing is lost when the mail
  // server is not configured: the delivery stays PENDING and the sweep takes it up once it is (FR-020).
  async deliverEmail(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { id: deliveryId, channel: 'EMAIL', status: 'PENDING' },
      include: { notification: { include: { user: { select: { email: true, status: true, deletedAt: true } } } } },
    });
    if (!delivery) return;
    const { notification, notification: { user } } = delivery;
    if (unavailable(user)) return this.finish(delivery.id, 'SKIPPED', 'ACCOUNT_UNAVAILABLE');
    const domain = await this.settings.get('auth.studentEmailDomain');
    if (!user.email || !hasEmailDomain(user.email, domain)) return this.finish(delivery.id, 'SKIPPED', 'EMAIL_DOMAIN_NOT_ALLOWED');

    const mail = await this.smtp.transport();
    if (!mail) {
      // No attempt is spent: nothing was tried.
      await this.prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { lastError: 'SMTP_NOT_CONFIGURED' } });
      return;
    }
    await this.prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { attempts: { increment: 1 } } });
    const content = renderNoticeMail(notification.type, notification.locale, notification);
    try {
      await mail.transport.sendMail(this.messages.build(mail.from, user.email, content));
    } catch (error) {
      throw new EmailSendError(smtpCause(error));
    }
    await this.finish(delivery.id, 'SENT', null);
  }

  // Puts back in the queue the deliveries that are still PENDING after a while: the queue was down
  // when they were created, or the email was waiting for the mail server to be configured (R-4).
  // The job id is the delivery id, so a delivery whose job is still alive is not duplicated.
  async sweep(limit = 500): Promise<number> {
    const olderThan = new Date(this.clock.now().getTime() - this.config.get('NOTIFICATION_SWEEP_SECONDS') * 1000);
    // Without a usable mail server the emails would only bounce back to PENDING: leave them.
    const mailReady = (await this.smtp.resolve()).credentials !== null;
    const pending = await this.prisma.notificationDelivery.findMany({
      where: { status: 'PENDING', updatedAt: { lt: olderThan }, ...(mailReady ? {} : { channel: { not: 'EMAIL' } }) },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, channel: true },
    });
    await this.queue.enqueue(pending);
    return pending.length;
  }

  // Drops the devices that the receipts report as gone.
  async checkReceipts(entries: readonly ReceiptEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const receipts = await this.push.getReceipts(entries.map((entry) => entry.ticketId));
    const gone = entries.filter((entry) => receipts.get(entry.ticketId) === 'DEVICE_NOT_REGISTERED').map((entry) => entry.token);
    if (gone.length === 0) return;
    await this.prisma.pushToken.updateMany({ where: { token: { in: gone }, deletedAt: null }, data: { deletedAt: this.clock.now() } });
    this.logger.log(`Dropped ${gone.length} push device(s) reported as unregistered`);
  }

  // The retries ran out (FR-022): final state and one log line with event type, channel and cause.
  async markFailed(deliveryId: string, cause: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { id: deliveryId, status: 'PENDING' },
      include: { notification: { select: { type: true } } },
    });
    if (!delivery) return;
    await this.finish(delivery.id, 'FAILED', cause);
    this.logger.error(`Delivery failed: event ${delivery.notification.type}, channel ${delivery.channel}, cause ${cause}`);
  }

  private async finish(id: string, status: DeliveryStatus, lastError: string | null): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: { status, lastError, ...(status === 'SENT' && { sentAt: this.clock.now() }) },
    });
  }
}
