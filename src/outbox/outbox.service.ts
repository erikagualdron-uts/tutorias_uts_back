import { Injectable } from '@nestjs/common';
import type { OutboxEventType, Prisma } from '@prisma/client';

// An event is about one module or one PQRS, never both (the table enforces it with a CHECK).
export type OutboxEventInput = {
  type: OutboxEventType;
  // Ids, names, dates and counts only. Never contact data of the enrolled students.
  payload: Prisma.InputJsonObject;
} & ({ moduleId: string; pqrsId?: never } | { pqrsId: string; moduleId?: never });

// Records the events that the notifications feature (spec 013) delivers later. It is always
// called with the transaction client, so the change and its event are saved together or not at all.
@Injectable()
export class OutboxService {
  async record(tx: Prisma.TransactionClient, event: OutboxEventInput): Promise<void> {
    await tx.outboxEvent.create({
      data: { type: event.type, moduleId: event.moduleId, pqrsId: event.pqrsId, payload: event.payload },
    });
  }
}
