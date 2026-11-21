export type SmtpCause = 'AUTH_FAILED' | 'CONNECTION_FAILED' | 'TIMEOUT' | 'SENDER_REJECTED' | 'UNKNOWN';

const CAUSES: Record<string, SmtpCause> = {
  EAUTH: 'AUTH_FAILED',
  ECONNECTION: 'CONNECTION_FAILED',
  ECONNREFUSED: 'CONNECTION_FAILED',
  ECONNRESET: 'CONNECTION_FAILED',
  ENOTFOUND: 'CONNECTION_FAILED',
  EDNS: 'CONNECTION_FAILED',
  ETIMEDOUT: 'TIMEOUT',
  ESOCKET: 'TIMEOUT',
  EENVELOPE: 'SENDER_REJECTED',
  EMESSAGE: 'SENDER_REJECTED',
};

// A stable cause for a failed send. The text of an SMTP error can carry the server, the user or an
// address, so it is never stored, logged or shown: only the code it maps to (FR-022, FR-028).
export function smtpCause(error: unknown): SmtpCause {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return (typeof code === 'string' && CAUSES[code]) || 'UNKNOWN';
}
