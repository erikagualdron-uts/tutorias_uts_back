import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { MessageView } from './chat-views.js';

// The way out for the realtime events. The gateway gives it the server when it starts, so the service can
// emit without depending on the gateway. Events only go to the room of each person, never to a
// conversation room: who is allowed to see a message is calculated for every message.
@Injectable()
export class ChatBroadcaster {
  private server: Server | null = null;

  attach(server: Server) {
    this.server = server;
  }

  messageNew(userIds: readonly string[], message: MessageView) {
    for (const id of userIds) this.server?.to(`user:${id}`).emit('message:new', message);
  }

  // The other person of a direct chat is typing (spec 022). Ephemeral: no text, nothing saved.
  typing(userId: string, conversationId: string, from: string) {
    this.server?.to(`user:${userId}`).emit('typing', { conversationId, userId: from });
  }

  unreadChanged(userId: string, unread: number) {
    this.server?.to(`user:${userId}`).emit('unread:changed', { unread });
  }
}
