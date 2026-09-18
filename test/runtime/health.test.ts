import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker runtime routes', () => {
  it('serves health from the production Hono app in workerd', async () => {
    const response = await SELF.fetch('https://cabinet.test/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
