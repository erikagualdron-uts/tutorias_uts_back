import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import type { Env } from '../config/env.js';
import { causeOf, DeliveriesService, type ReceiptEntry } from './deliveries.service.js';
import { NOTIFICATIONS_QUEUE } from './delivery-queue.js';
import { OutboxConsumer } from './outbox.consumer.js';

// Registers the repeatable jobs. BullMQ keeps one schedule per id, so two API instances do not
// double the polling; a restart picks the pending events up on the first poll.
@Injectable()
export class NotificationsScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onModuleInit() {
    const opts = { removeOnComplete: true, removeOnFail: true };
    await this.queue.upsertJobScheduler(
      'outbox',
      { every: this.config.get('OUTBOX_POLL_SECONDS') * 1000 },
      { name: 'outbox', opts },
    );
    await this.queue.upsertJobScheduler(
      'sweep',
      { every: this.config.get('NOTIFICATION_SWEEP_SECONDS') * 1000 },
      { name: 'sweep', opts },
    );
  }
}

// One worker for the queue: the poll of the outbox, the push and email deliveries, the push receipts and the sweep of pending deliveries. Tests replace it and call the services directly.
@Processor(NOTIFICATIONS_QUEUE, { concurrency: 5 })
export class NotificationsProcessor extends WorkerHost {
  constructor(
    private readonly outbox: OutboxConsumer,
    private readonly deliveries: DeliveriesService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'outbox':
        await this.outbox.run();
        return;
      case 'push':
        return this.deliveries.deliverPush((job.data as { deliveryId: string }).deliveryId);
      case 'email':
        return this.deliveries.deliverEmail((job.data as { deliveryId: string }).deliveryId);
      case 'sweep':
        await this.deliveries.sweep();
        return;
      case 'receipts':
        return this.deliveries.checkReceipts((job.data as { entries: ReceiptEntry[] }).entries);
    }
  }

  // BullMQ retries on its own; only when the attempts run out does the delivery become FAILED.
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    const deliveryId = (job?.data as { deliveryId?: string } | undefined)?.deliveryId;
    if (!job || !deliveryId) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) await this.deliveries.markFailed(deliveryId, causeOf(error));
  }
}
