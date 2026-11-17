export interface Env {
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_ACCESS_TTL_SECONDS: number;
  CODE_HMAC_SECRET: string;
  SMTP_ENCRYPTION_KEY: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  SMTP_FROM: string;
  THROTTLE_PUBLIC_LIMIT: number;
  THROTTLE_PUBLIC_TTL_SECONDS: number;
  HOLIDAYS_API_BASE_URL: string;
  HOLIDAYS_COUNTRY: string;
  HOLIDAYS_TIMEOUT_MS: number;
  MODULE_EARLIEST_MINUTE: number;
  MODULE_LATEST_MINUTE: number;
}

const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'CODE_HMAC_SECRET',
  'SMTP_ENCRYPTION_KEY',
] as const;

// The API must not start with a missing or weak secret (docs/Conventions.md §4).
export function validateEnv(raw: Record<string, string | undefined>): Env {
  const str = (key: string, fallback = '') => raw[key] ?? fallback;
  const num = (key: string, fallback: number) => Number(raw[key] ?? fallback);

  const missing = required.filter((key) => !raw[key]);
  if (missing.length)
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  if (str('JWT_SECRET').length < 32)
    throw new Error('JWT_SECRET must have at least 32 characters');
  if (!/^[0-9a-f]{64}$/i.test(str('SMTP_ENCRYPTION_KEY'))) {
    throw new Error('SMTP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }

  const holidaysCountry = str('HOLIDAYS_COUNTRY', 'CO');
  if (!/^[A-Z]{2}$/.test(holidaysCountry))
    throw new Error('HOLIDAYS_COUNTRY must be two uppercase letters');
  const holidaysTimeoutMs = num('HOLIDAYS_TIMEOUT_MS', 10000);
  if (!Number.isInteger(holidaysTimeoutMs) || holidaysTimeoutMs <= 0)
    throw new Error('HOLIDAYS_TIMEOUT_MS must be a positive integer');
  const holidaysBaseUrl = str(
    'HOLIDAYS_API_BASE_URL',
    'https://date.nager.at/api/v3',
  );
  if (!/^https?:\/\//.test(holidaysBaseUrl))
    throw new Error('HOLIDAYS_API_BASE_URL must be an http(s) URL');

  // Hours a module may be held (HH:mm, America/Bogota); a session ends by the latest, never after.
  const hhmm = (key: string, fallback: string) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(str(key, fallback));
    if (!match) throw new Error(`${key} must be a time as HH:mm`);
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const earliest = hhmm('MODULE_EARLIEST_TIME', '06:00');
  const latest = hhmm('MODULE_LATEST_TIME', '18:00');
  if (earliest >= latest)
    throw new Error('MODULE_EARLIEST_TIME must be before MODULE_LATEST_TIME');

  return {
    PORT: num('PORT', 3000),
    DATABASE_URL: str('DATABASE_URL'),
    JWT_SECRET: str('JWT_SECRET'),
    JWT_ACCESS_TTL_SECONDS: num('JWT_ACCESS_TTL_SECONDS', 900),
    CODE_HMAC_SECRET: str('CODE_HMAC_SECRET'),
    SMTP_ENCRYPTION_KEY: str('SMTP_ENCRYPTION_KEY'),
    REDIS_HOST: str('REDIS_HOST', 'localhost'),
    REDIS_PORT: num('REDIS_PORT', 6379),
    SMTP_HOST: str('SMTP_HOST', 'localhost'),
    SMTP_PORT: num('SMTP_PORT', 1025),
    SMTP_USER: str('SMTP_USER'),
    SMTP_PASSWORD: str('SMTP_PASSWORD'),
    SMTP_FROM: str('SMTP_FROM', 'no-reply@uts.edu.co'),
    THROTTLE_PUBLIC_LIMIT: num('THROTTLE_PUBLIC_LIMIT', 10),
    THROTTLE_PUBLIC_TTL_SECONDS: num('THROTTLE_PUBLIC_TTL_SECONDS', 3600),
    HOLIDAYS_API_BASE_URL: holidaysBaseUrl.replace(/\/+$/, ''),
    HOLIDAYS_COUNTRY: holidaysCountry,
    HOLIDAYS_TIMEOUT_MS: holidaysTimeoutMs,
    MODULE_EARLIEST_MINUTE: earliest,
    MODULE_LATEST_MINUTE: latest,
  };
}
