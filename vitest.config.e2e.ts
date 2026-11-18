import { defineConfig, loadEnv } from 'vite';

// Must be set before the app modules are imported: ConfigModule validates env at import time.
const env = loadEnv('test', process.cwd(), '');
if (!env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for e2e tests');

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    // All suites share one test database, so files must not run concurrently.
    fileParallelism: false,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: {
      DATABASE_URL: env.TEST_DATABASE_URL,
      // The suites call public endpoints far more often than the production limit allows.
      THROTTLE_PUBLIC_LIMIT: '100000',
    },
  },
});
