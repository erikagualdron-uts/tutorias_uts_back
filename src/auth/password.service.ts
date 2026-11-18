import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { AppException } from '../common/errors/app.exception.js';
import { SettingsService } from '../settings/settings.service.js';

@Injectable()
export class PasswordService {
  // Verified when the email does not exist so both paths take the same time.
  private dummyHash?: Promise<string>;

  constructor(private readonly settings: SettingsService) {}

  hash(password: string) {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string | null, password: string): Promise<boolean> {
    if (hash) return argon2.verify(hash, password);
    this.dummyHash ??= this.hash('dummy-password-for-timing');
    await argon2.verify(await this.dummyHash, password);
    return false;
  }

  async assertPolicy(password: string) {
    const minLength = await this.settings.get('auth.passwordMinLength');
    const valid =
      password.length >= minLength &&
      /[A-Za-z]/.test(password) &&
      /\d/.test(password);
    if (!valid) {
      throw new AppException(
        400,
        'PASSWORD_TOO_WEAK',
        `Password needs ${minLength}+ characters with letters and numbers`,
      );
    }
  }
}
