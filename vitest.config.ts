import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts', 'test/workflow/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
