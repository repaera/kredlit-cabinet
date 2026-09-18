import type { IntentQueueMessage, PendingActionWorkflowParams } from './types/flow.ts';

export interface Env {
  AI: Ai;
  HYPERDRIVE: Hyperdrive;
  INTENT_QUEUE: Queue<IntentQueueMessage>;
  PENDING_ACTION_WORKFLOW: Workflow<PendingActionWorkflowParams>;
  TELEGRAM_RATE_LIMITER: RateLimit;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  CABINET_MODEL?: 'worker-kimi' | 'worker-deepseek' | 'azure-kimi' | 'azure-deepseek';
  AZURE_GATEWAY_BASE_URL?: string;
  CF_AIG_TOKEN?: string;
}
