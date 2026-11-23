import { defineConfig, loadEnv } from 'vite';

// Measurement against the load database (spec 023); never part of `test` or `test:e2e`.
const env = loadEnv('test', process.cwd(), '');
const url = process.env.PERF_DATABASE_URL ?? env.PERF_DATABASE_URL;
if (!url) throw new Error('PERF_DATABASE_URL is required (the *_load database filled by seed:load)');
if (!new URL(url).pathname.slice(1).endsWith('_load'))
  throw new Error('PERF_DATABASE_URL must point to a database named *_load');

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['perf/**/*.perf-spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    env: { DATABASE_URL: url, THROTTLE_PUBLIC_LIMIT: '100000' },
  },
});
