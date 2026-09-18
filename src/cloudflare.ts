import type { Env } from './env.ts';
import { consumeBatch } from './queue/intent-consumer.ts';
import { dailySummary } from './scheduled/daily-summary.ts';
import type { IntentQueueMessage } from './types/flow.ts';

export { PendingActionWorkflow } from './workflows/pending-action-workflow.ts';

export default {
  queue: (batch: MessageBatch<IntentQueueMessage>, env: Env) => consumeBatch(batch, env),
  scheduled: (_controller: ScheduledController, env: Env) => dailySummary(env),
} satisfies ExportedHandler<Env, IntentQueueMessage>;
