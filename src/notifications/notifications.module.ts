import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DeliveriesService } from './deliveries.service.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';
import { DeliveryQueue, NOTIFICATIONS_QUEUE } from './delivery-queue.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsProcessor, NotificationsScheduler } from './notifications.processor.js';
import { NotificationsService } from './notifications.service.js';
import { OutboxConsumer } from './outbox.consumer.js';
import { ExpoPushGateway, PUSH_GATEWAY } from './push/push-gateway.js';

// Notices from module changes (spec 014): consumer of the outbox, inbox, devices and delivery.
// The providers of each story are added as it is built; the queue and the push port are shared.
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATIONS_QUEUE })],
  controllers: [NotificationsController, DevicesController],
  providers: [
    NotificationsService,
    DevicesService,
    DeliveriesService,
    OutboxConsumer,
    DeliveryQueue,
    NotificationsScheduler,
    NotificationsProcessor,
    // Tests replace this port so no push leaves the machine.
    { provide: PUSH_GATEWAY, useClass: ExpoPushGateway },
  ],
  exports: [PUSH_GATEWAY, DeliveryQueue, DeliveriesService],
})
export class NotificationsModule {}
