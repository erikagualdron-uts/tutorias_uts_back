import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ChatBroadcaster } from './chat-broadcaster.js';
import { ChatPresence } from './chat-presence.js';
import { ChatPushService } from './chat-push.service.js';
import { ChatRetentionTask } from './chat-retention.task.js';
import { ChatTypingLimiter } from './chat-typing.js';
import { ChatController } from './chat.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { ChatService } from './chat.service.js';

// Chat and announcements (spec 018). AuthModule gives the gateway the same token and session checks of the
// HTTP guard; NotificationsModule gives the push port.
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, ChatPresence, ChatBroadcaster, ChatPushService, ChatRetentionTask, ChatTypingLimiter],
})
export class ChatModule {}
