import { execFileSync } from 'node:child_process';
import { parseIntent } from '../src/llm/parse-intent.ts';

try { process.loadEnvFile('.dev.vars'); } catch {}

const workerUrl = process.argv[2]?.replace(/\/$/, '');
if (!workerUrl) throw new Error('Usage: pnpm audit:wiring <worker-url>');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return body;
}

function wrangler(...args: string[]): string {
  return execFileSync('pnpm', ['exec', 'wrangler', ...args], { encoding: 'utf8', env: process.env });
}

const health = await json(`${workerUrl}/health`);
if (health.ok !== true) throw new Error('Worker health check failed');
console.log('Worker health: ok');

const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
const bot = await json(`https://api.telegram.org/bot${telegramToken}/getMe`);
const botResult = bot.result as { can_read_all_group_messages?: boolean } | undefined;
if (bot.ok !== true || botResult?.can_read_all_group_messages !== true) throw new Error('Telegram bot privacy is not disabled');
const webhook = await json(`https://api.telegram.org/bot${telegramToken}/getWebhookInfo`);
const webhookResult = webhook.result as { url?: string; pending_update_count?: number; last_error_message?: string } | undefined;
if (webhookResult?.url !== `${workerUrl}/telegram/webhook` || webhookResult.last_error_message) throw new Error('Telegram webhook is unhealthy');
console.log(`Telegram: ok (${webhookResult.pending_update_count ?? 0} pending)`);

if (!wrangler('queues', 'info', 'cabinet-intent-queue').includes('cabinet-intent-queue')) throw new Error('Queue not found');
if (!wrangler('hyperdrive', 'list').includes('cabinet-db')) throw new Error('Hyperdrive not found');
if (!wrangler('workflows', 'describe', 'cabinet-pending-action').includes('cabinet-pending-action')) throw new Error('Workflow not found');
console.log('Cloudflare resources: ok');

const model = process.env.CABINET_MODEL ?? 'worker-kimi';
if (model.startsWith('azure-')) {
  const intents = await parseIntent({
    CABINET_MODEL: model,
    AZURE_GATEWAY_BASE_URL: requireEnv('AZURE_GATEWAY_BASE_URL'),
    CF_AIG_TOKEN: requireEnv('CF_AIG_TOKEN'),
  } as never, 'check stock for diagnostic item', []);
  if (intents[0]?.toolName !== 'check_stock') throw new Error('Azure model returned an unusable diagnostic intent');
  console.log(`Model ${model}: ok`);
} else {
  console.log(`Model ${model}: skipped locally (native Worker binding)`);
}

console.log('Wiring audit passed.');
