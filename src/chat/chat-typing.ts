import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';

const WINDOW_MS = 2_000;

// At most one "is typing" notice per socket and conversation every 2 seconds (spec 022): a client that sends
// it on every key press cannot flood the other person. In memory only, forgotten when the socket drops.
@Injectable()
export class ChatTypingLimiter {
  private readonly last = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  accept(socketId: string, conversationId: string): boolean {
    const key = `${socketId}:${conversationId}`;
    const now = this.clock.now().getTime();
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < WINDOW_MS) return false;
    this.last.set(key, now);
    return true;
  }

  drop(socketId: string) {
    for (const key of this.last.keys()) if (key.startsWith(`${socketId}:`)) this.last.delete(key);
  }
}
