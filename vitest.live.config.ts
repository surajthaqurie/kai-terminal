import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/**/*.live.test.ts'],
    testTimeout: 30000,
  },
});
