import { Transform } from 'class-transformer';

// Surrounding spaces are not part of an email or a name (FR-032).
export const Trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
