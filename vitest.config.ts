import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://ks:ks@localhost:5432/ks_test',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      CRON_SECRET: 'test-cron-secret',
      APP_URL: 'https://kretasync.test',
      SYNC_DAYS: '14',
    },
  },
});
