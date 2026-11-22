import { Injectable } from '@nestjs/common';

// Which conversation each connected device has open, in memory. Good for one server instance, which is
// what runs today; with several instances Socket.IO would need the Redis adapter (docs/Architecture.md).
@Injectable()
export class ChatPresence {
  private readonly users = new Map<string, string>();
  private readonly openBySocket = new Map<string, Set<string>>();

  bind(socketId: string, userId: string) {
    this.users.set(socketId, userId);
    this.openBySocket.set(socketId, new Set());
  }

  open(socketId: string, conversationId: string) {
    this.openBySocket.get(socketId)?.add(conversationId);
  }

  close(socketId: string, conversationId: string) {
    this.openBySocket.get(socketId)?.delete(conversationId);
  }

  drop(socketId: string) {
    this.users.delete(socketId);
    this.openBySocket.delete(socketId);
  }

  isOpen(userId: string, conversationId: string): boolean {
    for (const [socketId, owner] of this.users) {
      if (owner === userId && this.openBySocket.get(socketId)?.has(conversationId)) return true;
    }
    return false;
  }
}
