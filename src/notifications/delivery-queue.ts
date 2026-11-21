import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NotificationChannel } from '@prisma/client';
import { Queue } from 'bullmq';
import type { Env } from '../config/env.js';

export const NOTIFICATIONS_QUEUE = 'notifications';

export interface DeliveryJob {
  id: string;
  channel: NotificationChannel;
}

export type DeliveryJobName = 'push' | 'email';

// Expo needs a moment before the receipts of a send are ready.
const RECEIPTS_DELAY_MS = 15 * 60_000;

export const jobNameOf = (channel: NotificationChannel): DeliveryJobName => (channel === 'PUSH' ? 'push' : 'email');

// The only place that talks to the queue for deliveries. The job id is the delivery id, so adding the
// same delivery twice (the sweep, a retry of the enqueue) never duplicates the send. Tests replace it.
@Injectable()
export class DeliveryQueue {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async enqueue(jobs: readonly DeliveryJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.queue.addBulk(
      jobs.map(({ id, channel }) => ({
        name: jobNameOf(channel),
        data: { deliveryId: id },
        opts: {
          jobId: id,
          attempts: this.config.get('NOTIFICATION_DELIVERY_ATTEMPTS'),
          backoff: { type: 'exponential', delay: this.config.get('NOTIFICATION_BACKOFF_SECONDS') * 1000 },
          // A finished job must not block a later re-add of a delivery that is still PENDING.
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    );
  }

  // Checks the push receipts later, with the token of each ticket; the job holds only tokens and ids.
  async enqueueReceipts(entries: readonly { ticketId: string; token: string }[]): Promise<void> {
    await this.queue.add('receipts', { entries }, {
      delay: RECEIPTS_DELAY_MS,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
