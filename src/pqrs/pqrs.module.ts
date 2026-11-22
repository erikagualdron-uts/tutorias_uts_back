import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PqrsController } from './pqrs.controller.js';
import { PqrsService } from './pqrs.service.js';

@Module({ imports: [OutboxModule], controllers: [PqrsController], providers: [PqrsService] })
export class PqrsModule {}
