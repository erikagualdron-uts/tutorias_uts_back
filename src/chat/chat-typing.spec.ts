import { describe, expect, it } from 'vitest';
import { ChatTypingLimiter } from './chat-typing.js';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function limiter() {
  let now = 1_000_000;
  const instance = new ChatTypingLimiter({ now: () => new Date(now) } as never);
  return { instance, advance: (ms: number) => (now += ms) };
}

describe('ChatTypingLimiter', () => {
  it('accepts the first notice of a socket in a conversation', () => {
    expect(limiter().instance.accept('s1', CONVERSATION)).toBe(true);
  });

  it('drops another one of the same socket and conversation within 2 seconds, and accepts it at 2 seconds', () => {
    const { instance, advance } = limiter();
    expect(instance.accept('s1', CONVERSATION)).toBe(true);
    advance(1_999);
    expect(instance.accept('s1', CONVERSATION)).toBe(false);
    advance(1);
    expect(instance.accept('s1', CONVERSATION)).toBe(true);
  });

  it('does not let a dropped notice push the window forward', () => {
    const { instance, advance } = limiter();
    instance.accept('s1', CONVERSATION);
    advance(1_500);
    instance.accept('s1', CONVERSATION); // dropped
    advance(600);
    expect(instance.accept('s1', CONVERSATION)).toBe(true); // 2.1 s after the first one
  });

  it('keeps another socket or another conversation apart', () => {
    const { instance } = limiter();
    instance.accept('s1', CONVERSATION);
    expect(instance.accept('s2', CONVERSATION)).toBe(true);
    expect(instance.accept('s1', OTHER)).toBe(true);
  });

  it('forgets a socket when it drops', () => {
    const { instance } = limiter();
    instance.accept('s1', CONVERSATION);
    instance.drop('s1');
    expect(instance.accept('s1', CONVERSATION)).toBe(true);
  });
});
