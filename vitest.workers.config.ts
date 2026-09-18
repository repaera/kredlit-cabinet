import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    main: './src/http/router.ts',
    miniflare: { compatibilityDate: '2026-09-18' },
  })],
  test: { include: ['test/runtime/**/*.test.ts'] },
});
