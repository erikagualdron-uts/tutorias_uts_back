import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { decryptAesGcm } from '../common/crypto.util.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type SmtpStatus = 'NOT_CONFIGURED' | 'CONFIGURED' | 'NEEDS_RECONFIGURATION';

export interface SmtpCredentials {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

// The password is never part of the view: only whether one is stored.
export interface SmtpView {
  status: SmtpStatus;
  usingEnvironment: boolean;
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
}

export type TransportFactory = (options: Record<string, unknown>) => Transporter;
export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');

const TIMEOUT_MS = 10_000;

// Where the mail server settings come from, in order: the row the CAE saved, the SMTP_* environment
// variables, nothing (sending stays pending). Read on every send, so a change applies without a restart.
@Injectable()
export class SmtpConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    @Inject(MAIL_TRANSPORT_FACTORY) private readonly createTransport: TransportFactory,
  ) {}

  async resolve(): Promise<{ view: SmtpView; credentials: SmtpCredentials | null }> {
    const stored = await this.prisma.smtpConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (stored) return this.fromStored(stored);
    return this.fromEnvironment();
  }

  async describe(): Promise<SmtpView> {
    return (await this.resolve()).view;
  }

  // Null when there is nothing usable to send with.
  async transport(): Promise<{ transport: Transporter; from: string } | null> {
    const { credentials } = await this.resolve();
    if (!credentials) return null;
    const { host, port, user, pass, from } = credentials;
    const transport = this.createTransport({
      host,
      port,
      secure: port === 465,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      ...(user && { auth: { user, pass } }),
    });
    return { transport, from };
  }

  private fromStored(row: { host: string; port: number; user: string; passwordEncrypted: string; from: string }) {
    const base = { host: row.host, port: row.port, user: row.user, from: row.from, usingEnvironment: false };
    try {
      const pass = decryptAesGcm(this.config.get('SMTP_ENCRYPTION_KEY'), row.passwordEncrypted);
      return {
        view: { ...base, status: 'CONFIGURED' as const, hasPassword: pass.length > 0 },
        credentials: { host: row.host, port: row.port, user: row.user, pass, from: row.from },
      };
    } catch {
      // The server key changed: the stored password cannot be read, so the CAE must save it again.
      return { view: { ...base, status: 'NEEDS_RECONFIGURATION' as const, hasPassword: true }, credentials: null };
    }
  }

  private fromEnvironment() {
    const host = this.config.get('SMTP_HOST');
    const from = this.config.get('SMTP_FROM');
    if (!host || !from) {
      const none = { host: null, port: null, user: null, from: null, hasPassword: false };
      return { view: { ...none, status: 'NOT_CONFIGURED' as const, usingEnvironment: false }, credentials: null };
    }
    const port = Number(this.config.get('SMTP_PORT'));
    const user = this.config.get('SMTP_USER');
    const pass = this.config.get('SMTP_PASSWORD');
    return {
      view: { status: 'CONFIGURED' as const, usingEnvironment: true, host, port, user: user || null, from, hasPassword: pass.length > 0 },
      credentials: { host, port, user, pass, from },
    };
  }
}
