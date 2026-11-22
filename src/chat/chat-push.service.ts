import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Locale, MessageKind } from '@prisma/client';
import { Redis } from 'ioredis';
import { liveDevices } from '../notifications/devices.js';
import { PUSH_GATEWAY, type PushGateway, type PushMessage } from '../notifications/push/push-gateway.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS } from '../redis/redis.module.js';
import { SettingsService } from '../settings/settings.service.js';
import { ChatPresence } from './chat-presence.js';

const PREVIEW = 140;
const clip = (text: string) => (text.length > PREVIEW ? `${text.slice(0, PREVIEW - 1)}…` : text);
const ANNOUNCEMENT: Record<Locale, string> = { es: 'Anuncio', en: 'Announcement' };

export interface ChatPushInput {
  conversationId: string;
  senderName: string;
  kind: MessageKind;
  body: string;
  // Null in a direct chat; the name of the module in a module chat.
  moduleName: string | null;
  recipients: { id: string; locale: Locale }[];
}

// The push of a chat message for whoever does not have that conversation open. Direct chat: one push per
// burst. Module chat: only announcements. Best effort: the message is already saved, so a failure here is
// logged by cause and never reaches the sender.
@Injectable()
export class ChatPushService {
  private readonly logger = new Logger(ChatPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: ChatPresence,
    private readonly settings: SettingsService,
    @Inject(PUSH_GATEWAY) private readonly gateway: PushGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async notify(input: ChatPushInput): Promise<void> {
    try {
      const direct = input.moduleName === null;
      if (!direct && input.kind !== 'ANNOUNCEMENT') return;
      const burst = await this.settings.get('chat.pushBurstSeconds');
      const messages: (PushMessage & { deviceId: string })[] = [];
      for (const recipient of input.recipients) {
        if (this.presence.isOpen(recipient.id, input.conversationId)) continue;
        if (direct && !(await this.redis.set(`chat:push:${input.conversationId}:${recipient.id}`, '1', 'EX', burst, 'NX'))) continue;
        const title = direct ? input.senderName : `${ANNOUNCEMENT[recipient.locale]} · ${input.moduleName}`;
        for (const device of await liveDevices(this.prisma, recipient.id, new Date())) {
          messages.push({ to: device.token, title, body: clip(input.body), data: { conversationId: input.conversationId }, deviceId: device.id });
        }
      }
      if (messages.length === 0) return;
      const tickets = await this.gateway.send(messages.map(({ deviceId: _deviceId, ...message }) => message));
      const gone = messages.filter((_, i) => {
        const ticket = tickets[i];
        return ticket && !ticket.ok && ticket.error === 'DEVICE_NOT_REGISTERED';
      });
      if (gone.length > 0) {
        await this.prisma.pushToken.updateMany({ where: { id: { in: gone.map((m) => m.deviceId) } }, data: { deletedAt: new Date() } });
      }
    } catch (error) {
      this.logger.error(`Could not send the chat push: ${error instanceof Error ? error.name : 'Error'}`);
    }
  }
}
