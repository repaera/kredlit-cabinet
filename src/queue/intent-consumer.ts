import * as v from 'valibot';
import { createDb } from '../db/client.ts';
import type { Env } from '../env.ts';
import { runPostWriteEffects } from '../lib/post-write-effects.ts';
import { sendMessage } from '../telegram/client.ts';
import { formatToolResult, loadToolPresentation } from '../telegram/messages.ts';
import { executeQueuedIntent } from '../tools/execute-intent.ts';
import { IntentQueueMessageSchema, type IntentQueueMessage } from '../types/flow.ts';

function pendingId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

export async function consumeIntent(body: unknown, env: Env): Promise<void> {
  const message = v.parse(IntentQueueMessageSchema, body);
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    if (message.requiresConfirmation) {
      const id = pendingId();
      const [tenant] = await db<{ settings: { confirmTimeoutMinutes?: number } }[]>`select settings from tenants where id = ${message.tenantId}`;
      const timeoutMinutes = tenant?.settings.confirmTimeoutMinutes ?? 10;
      try {
        await db`
          insert into pending_actions (id, tenant_id, chat_id, user_id, kind, intent, workflow_instance_id, expires_at)
          values (${id}, ${message.tenantId}, ${message.chatId}, ${message.userId}, 'confirmation', ${db.json(message as never)}, ${id}, now() + ${timeoutMinutes + ' minutes'}::interval)`;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === '23505') {
          await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: message.chatId, text: '⏳ Action pending\n\nPlease resolve your current confirmation first.' });
          return;
        }
        throw error;
      }
      await env.PENDING_ACTION_WORKFLOW.create({ id, params: { pendingActionId: id, tenantId: message.tenantId, chatId: message.chatId, userId: message.userId, kind: 'confirmation', intent: message as unknown as Record<string, unknown>, timeoutMinutes } });
      return;
    }
    const output = await executeQueuedIntent(db, message);
    const presentation = await loadToolPresentation(db, message.tenantId, message.toolInput);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: message.chatId, text: formatToolResult(message.toolName, message.toolInput, output, presentation) });
    await runPostWriteEffects(db, env.TELEGRAM_BOT_TOKEN, message, output);
  } finally {
    await db.end();
  }
}

export async function consumeBatch(batch: MessageBatch<IntentQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await consumeIntent(message.body, env);
      message.ack();
    } catch (error) {
      console.error('Intent processing failed', message.body.id, error instanceof Error ? error.name : 'UnknownError');
      message.retry();
    }
  }
}
