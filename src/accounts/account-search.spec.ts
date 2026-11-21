import { describe, expect, it } from 'vitest';
import { escapeLike, searchCondition } from './account-search.js';

const raw = String.raw;

describe('escapeLike', () => {
  it.each([
    ['100%', raw`100\%`],
    ['a_b', raw`a\_b`],
    [raw`a\b`, raw`a\\b`],
  ])('escapes %s literally', (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });
});

describe('searchCondition', () => {
  it.each([undefined, '', '   '])('does not filter on %j', (term) => {
    expect(searchCondition(term).sql.trim()).toBe('TRUE');
  });

  it('covers first name, last name and email with the escaped pattern', () => {
    const cond = searchCondition(' 50%_ ');
    expect(cond.sql).toContain('p.first_name');
    expect(cond.sql).toContain('p.last_name');
    expect(cond.sql).toContain('u.email');
    expect(cond.sql).toContain('unaccent');
    expect(cond.values).toContain(raw`%50\%\_%`);
  });
});
