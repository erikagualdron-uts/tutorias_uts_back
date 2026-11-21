import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { encryptAesGcm } from '../common/crypto.util.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { SmtpConfigService, type TransportFactory } from './smtp-config.service.js';

const KEY = 'c'.repeat(64);

function build(env: Record<string, string>, row: object | null) {
  const prisma = { smtpConfig: { findFirst: vi.fn().mockResolvedValue(row) } } as unknown as PrismaService;
  const config = { get: (key: string) => env[key] } as unknown as ConfigService<never, true>;
  const factory = vi.fn() as unknown as TransportFactory & ReturnType<typeof vi.fn>;
  return { service: new SmtpConfigService(prisma, config as never, factory), factory };
}

const storedRow = (password: string, key = KEY) => ({
  host: 'smtp.uts.edu.co',
  port: 587,
  user: 'cae',
  passwordEncrypted: encryptAesGcm(key, password),
  from: 'cae@uts.edu.co',
});

const env = { SMTP_ENCRYPTION_KEY: KEY, SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: 'no-reply@uts.edu.co' };

describe('SmtpConfigService', () => {
  it('prefers the stored row over the environment', async () => {
    const { service } = build(env, storedRow('secret'));
    const { view, credentials } = await service.resolve();
    expect(view).toMatchObject({ status: 'CONFIGURED', usingEnvironment: false, host: 'smtp.uts.edu.co', hasPassword: true });
    expect(credentials?.pass).toBe('secret');
  });

  it('falls back to the environment when there is no row', async () => {
    const { service } = build(env, null);
    const { view } = await service.resolve();
    expect(view).toMatchObject({ status: 'CONFIGURED', usingEnvironment: true, host: 'localhost', port: 1025, user: null });
  });

  it('is NOT_CONFIGURED without a row or SMTP_HOST', async () => {
    const { service } = build({ ...env, SMTP_HOST: '' }, null);
    expect((await service.describe()).status).toBe('NOT_CONFIGURED');
    expect(await service.transport()).toBeNull();
  });

  it('needs reconfiguration when the stored password cannot be decrypted', async () => {
    const { service } = build(env, storedRow('secret', 'd'.repeat(64)));
    const { view, credentials } = await service.resolve();
    expect(view.status).toBe('NEEDS_RECONFIGURATION');
    expect(credentials).toBeNull();
    expect(await service.transport()).toBeNull();
  });

  it('never exposes the password in the view', async () => {
    const { service } = build(env, storedRow('top-secret'));
    expect(JSON.stringify(await service.describe())).not.toContain('top-secret');
  });

  it('builds the transport with TLS only on port 465 and auth only with a user', async () => {
    const { service, factory } = build(env, storedRow('secret'));
    await service.transport();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ secure: false, auth: { user: 'cae', pass: 'secret' } }));
    const plain = build(env, null);
    await plain.service.transport();
    expect(plain.factory.mock.calls[0][0]).not.toHaveProperty('auth');
  });
});
