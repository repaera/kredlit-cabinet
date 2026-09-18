import type { Env } from '../env.ts';

export type ProviderConfig =
  | { kind: 'workers-ai'; model: string; binding: Ai }
  | { kind: 'azure'; model: string; url: string; headers: Record<string, string> };

const models = {
  'worker-kimi': '@cf/moonshotai/kimi-k2.6',
  'worker-deepseek': '@cf/deepseek-ai/deepseek-v4-pro-0813',
  'azure-kimi': 'Kimi-K2.6',
  'azure-deepseek': 'DeepSeek-V4-Pro',
} as const;

export function resolveProvider(env: Pick<Env, 'AI' | 'CABINET_MODEL' | 'AZURE_GATEWAY_BASE_URL' | 'CF_AIG_TOKEN'>): ProviderConfig {
  const selection = env.CABINET_MODEL ?? 'worker-kimi';
  const model = models[selection];
  if (selection.startsWith('worker-')) return { kind: 'workers-ai', model, binding: env.AI };
  if (!env.AZURE_GATEWAY_BASE_URL) throw new Error('AZURE_GATEWAY_BASE_URL is required for Azure');
  if (!env.CF_AIG_TOKEN) throw new Error('CF_AIG_TOKEN is required for Azure BYOK');
  const configured = env.AZURE_GATEWAY_BASE_URL.replace(/\/$/, '');
  const url = configured.includes('/chat/completions')
    ? configured.replace(/\/(?:DeepSeek-V4-Pro|Kimi-K2\.6)(\/chat\/completions)/, `/${model}$1`)
    : `${configured}/${model}/chat/completions?api-version=2024-10-21`;
  return {
    kind: 'azure',
    model,
    url,
    headers: { 'content-type': 'application/json', 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}` },
  };
}
