import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'cloudflare',
  app: './src/http/router.ts',
  cloudflare: './src/cloudflare.ts',
  providers: ['cloudflare'],
});
