// Prisma wraps database errors differently depending on the adapter, so we look for the
// constraint name anywhere in the error instead of relying on a single error shape.
export function violatedConstraint(error: unknown, names: readonly string[]): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { message?: string; meta?: unknown; cause?: unknown };
  let text = e.message ?? '';
  try {
    text += JSON.stringify(e.meta ?? {}) + JSON.stringify(e.cause ?? {});
  } catch {
    // circular structures: the message alone is enough
  }
  return names.find((name) => text.includes(name));
}
