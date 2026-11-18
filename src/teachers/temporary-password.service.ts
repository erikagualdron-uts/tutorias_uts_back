import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';

const pick = (alphabet: string) => alphabet[randomInt(alphabet.length)];

@Injectable()
export class TemporaryPasswordService {
  // 12 characters, always with letters and digits so it meets the password policy.
  generate(): string {
    const chars = [
      pick(LETTERS),
      pick(DIGITS),
      ...Array.from({ length: 10 }, () => pick(LETTERS + DIGITS)),
    ];
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }
}
