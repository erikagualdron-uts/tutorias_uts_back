import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PUBLIC_ROUTES } from './utils/route-policy.js';
import type { TestContext } from './utils/test-app.js';

const LIMIT = 2;

// The limit is read when the app module loads, so it is set before importing the app.
describe('public routes are rate limited', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    vi.stubEnv('THROTTLE_PUBLIC_LIMIT', String(LIMIT));
    const { createTestApp } = await import('./utils/test-app.js');
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.close();
    vi.unstubAllEnvs();
  });

  it.each(Object.keys(PUBLIC_ROUTES))('%s answers 429 RATE_LIMITED past the limit', async (route) => {
    const [method, path] = route.split(' ');
    const call = () => ctx.http()[method.toLowerCase() as 'post'](path).send({});
    for (let i = 0; i < LIMIT; i++) expect((await call()).status).not.toBe(429);
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });
});
