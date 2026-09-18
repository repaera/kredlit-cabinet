import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIntent } from '../../src/llm/parse-intent.ts';

function workersEnv(response: unknown) {
  const run = vi.fn().mockResolvedValue(response);
  return { env: { AI: { run }, CABINET_MODEL: 'worker-kimi' } as never, run };
}

function azureEnv() {
  return {
    CABINET_MODEL: 'azure-kimi',
    AZURE_GATEWAY_BASE_URL: 'https://gateway.example/azure-openai/resource',
    CF_AIG_TOKEN: 'test-token',
  } as never;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseIntent', () => {
  it('parses a raw Workers AI object response', async () => {
    const { env, run } = workersEnv({ response: '{"toolName":"check_stock","toolInput":{"itemNameOrId":"Soap"}}' });

    await expect(parseIntent(env, 'check Soap', [])).resolves.toEqual([
      { toolName: 'check_stock', toolInput: { itemNameOrId: 'Soap' } },
    ]);
    expect(run).toHaveBeenCalledWith('@cf/moonshotai/kimi-k2.6', expect.objectContaining({ prompt: expect.stringContaining('check Soap') }));
  });

  it('parses a fenced Workers AI string response', async () => {
    const { env } = workersEnv('```json\n[{"toolName":"list_low_stock","toolInput":{}}]\n```');

    await expect(parseIntent(env, 'low stock', [])).resolves.toEqual([
      { toolName: 'list_low_stock', toolInput: {} },
    ]);
  });

  it('parses an Azure array response without a live request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { content: '[{"toolName":"create_location","toolInput":{"name":"Store","type":"physical"}},{"toolName":"create_location","toolInput":{"name":"Web","type":"own_website"}}]' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(parseIntent(azureEnv(), 'create Store and Web', [])).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/Kimi-K2.6/chat/completions?api-version=2024-10-21'),
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'cf-aig-authorization': 'Bearer test-token' }) }),
    );
  });

  it('rejects malformed provider output', async () => {
    await expect(parseIntent(workersEnv({ response: 'not json' }).env, 'anything', [])).rejects.toThrow();
  });
});
