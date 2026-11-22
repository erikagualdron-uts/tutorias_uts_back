import { Prisma } from '@prisma/client';

export const escapeLike = (term: string) => term.replace(/[\\%_]/g, '\\$&');

// Accent- and case-insensitive match on `p.first_name`, `p.last_name` and `u.email`
// (the caller aliases the profile as `p` and `users` as `u`).
export function searchCondition(term?: string): Prisma.Sql {
  const clean = term?.trim();
  if (!clean) return Prisma.sql`TRUE`;
  const pattern = `%${escapeLike(clean)}%`;
  const like = (column: Prisma.Sql) =>
    Prisma.sql`unaccent(lower(${column})) LIKE unaccent(lower(${pattern}))`;
  return Prisma.sql`(${like(Prisma.sql`p.first_name`)} OR ${like(Prisma.sql`p.last_name`)} OR ${like(Prisma.sql`u.email`)})`;
}
