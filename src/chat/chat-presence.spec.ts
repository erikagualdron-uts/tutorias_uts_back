import { describe, expect, it } from 'vitest';
import { ChatPresence } from './chat-presence.js';

describe('ChatPresence', () => {
  it('marks a conversation open for the user while a socket has it open', () => {
    const presence = new ChatPresence();
    presence.bind('s1', 'u1');
    presence.open('s1', 'c1');
    expect(presence.isOpen('u1', 'c1')).toBe(true);
    expect(presence.isOpen('u1', 'c2')).toBe(false);
    expect(presence.isOpen('u2', 'c1')).toBe(false);
  });

  it('closes a conversation on request and on disconnect', () => {
    const presence = new ChatPresence();
    presence.bind('s1', 'u1');
    presence.open('s1', 'c1');
    presence.open('s1', 'c2');
    presence.close('s1', 'c1');
    expect(presence.isOpen('u1', 'c1')).toBe(false);
    expect(presence.isOpen('u1', 'c2')).toBe(true);
    presence.drop('s1');
    expect(presence.isOpen('u1', 'c2')).toBe(false);
  });

  it('keeps it open while any other socket of the same user still has it open', () => {
    const presence = new ChatPresence();
    presence.bind('phone', 'u1');
    presence.bind('tablet', 'u1');
    presence.open('phone', 'c1');
    presence.open('tablet', 'c1');
    presence.drop('phone');
    expect(presence.isOpen('u1', 'c1')).toBe(true);
    presence.close('tablet', 'c1');
    expect(presence.isOpen('u1', 'c1')).toBe(false);
  });

  it('ignores a socket that was never bound and dropping twice', () => {
    const presence = new ChatPresence();
    presence.open('ghost', 'c1');
    expect(presence.isOpen('u1', 'c1')).toBe(false);
    presence.drop('ghost');
    presence.drop('ghost');
  });
});
