import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import * as v from 'valibot';
import { createDb } from '../db/client.ts';
import type { Env } from '../env.ts';
import { encodeLocationCallback } from '../lib/callback-data.ts';
import { resolveIntentLocations } from '../lib/location-resolution.ts';
import { runPostWriteEffects } from '../lib/post-write-effects.ts';
import { sendMessage } from '../telegram/client.ts';
import { formatAdjustmentPrompt, formatToolResult, loadToolPresentation } from '../telegram/messages.ts';
import { executeQueuedIntent } from '../tools/execute-intent.ts';
import { IntentQueueMessageSchema, PendingActionWorkflowParamsSchema, WorkflowUserResponseSchema, type IntentQueueMessage, type LocationField, type PendingActionWorkflowParams, type WorkflowUserResponse } from '../types/flow.ts';
import { AddStockInputSchema, AdjustStockInputSchema, CreateItemInputSchema, CreateLocationInputSchema, RemoveStockInputSchema, SetReorderThresholdInputSchema, ToolContextSchema, TransferStockInputSchema } from '../types/tools.ts';

type LocationStepResult = { done: true; notification?: string } | { done: false; field: LocationField; message: IntentQueueMessage };

function validateResolvedIntent(message: IntentQueueMessage): void {
  const schemas = {
    create_location: CreateLocationInputSchema,
    create_item: CreateItemInputSchema,
    add_stock: AddStockInputSchema,
    remove_stock: RemoveStockInputSchema,
    transfer_stock: TransferStockInputSchema,
    adjust_stock: AdjustStockInputSchema,
    set_reorder_threshold: SetReorderThresholdInputSchema,
  };
  v.parse(schemas[message.toolName], message.toolInput);
}

export class PendingActionWorkflow extends WorkflowEntrypoint<Env, PendingActionWorkflowParams> {
  async run(event: WorkflowEvent<PendingActionWorkflowParams>, step: WorkflowStep): Promise<void> {
    const params = v.parse(PendingActionWorkflowParamsSchema, event.payload);
    let message = v.parse(IntentQueueMessageSchema, params.intent);
    const context = v.parse(ToolContextSchema, message.toolInput);
    if (context.tenantId !== params.tenantId || context.chatId !== params.chatId || context.userId !== params.userId || message.tenantId !== params.tenantId || message.chatId !== params.chatId || message.userId !== params.userId) {
      throw new Error('Pending action ownership does not match its parked intent');
    }
    const expiredBeforeStart = await step.do('check pending expiry', async () => {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        const [pending] = await db<{ expired: boolean }[]>`
          select expires_at <= now() expired from pending_actions
          where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
            and user_id = ${params.userId} and status = 'pending'`;
        if (!pending) throw new Error('Pending action is not active or owned by this workflow');
        return pending.expired;
      } finally { await db.end(); }
    });
    if (expiredBeforeStart) {
      await this.expire(params, step);
      return;
    }
    if (params.kind === 'confirmation') {
      if (message.toolName !== 'adjust_stock' || !message.requiresConfirmation) throw new Error('Confirmation workflow has the wrong parked intent kind');
      v.parse(AdjustStockInputSchema, message.toolInput);
      await this.runConfirmation(params, message, step);
      return;
    }

    let field = params.missingLocationField;
    if (!field) throw new Error('Location workflow is missing its field');

    for (let attempt = 0; attempt < 2; attempt++) {
      const currentField: LocationField = field;
      await step.do(`send location prompt ${attempt}`, async () => {
        const db = createDb(this.env.HYPERDRIVE.connectionString);
        try {
          const [pending] = await db<{ id: string }[]>`
            select id from pending_actions
            where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
              and user_id = ${params.userId} and kind = 'location_disambiguation' and status = 'pending'
              and missing_location_field = ${currentField} and expires_at > now()`;
          if (!pending) throw new Error('Pending location action is not active or owned by this workflow');
          const excluded = currentField === 'toLocationId' && typeof message.toolInput.fromLocationId === 'string' ? message.toolInput.fromLocationId : '';
          const locations = await db<{ id: string; name: string }[]>`select id, name from locations where tenant_id = ${params.tenantId} and id::text <> ${excluded} order by name`;
          await sendMessage(this.env.TELEGRAM_BOT_TOKEN, {
            chatId: params.chatId,
            text: `📍 Choose ${currentField === 'fromLocationId' ? 'a source' : currentField === 'toLocationId' ? 'a destination' : 'a location'}\n\nTap one of the options below.`,
            replyMarkup: { inlineKeyboard: locations.map((location) => [{ text: location.name, callbackData: encodeLocationCallback(params.pendingActionId, currentField, location.id.slice(0, 12)) }]) },
          });
        } finally { await db.end(); }
      });

      let received: { payload: unknown };
      try {
        received = await step.waitForEvent<WorkflowUserResponse>(`wait for location ${attempt}`, { type: 'user-response', timeout: params.timeoutMinutes * 60_000 });
      } catch {
        await this.expire(params, step);
        return;
      }
      const response = v.parse(WorkflowUserResponseSchema, received.payload);
      if (response.kind !== 'location_disambiguation') throw new Error('Location workflow received the wrong event kind');
      if (response.field !== currentField) throw new Error('Location workflow received the wrong field');

      const result: LocationStepResult = await step.do(`resolve location ${attempt}`, async (): Promise<LocationStepResult> => {
        const db = createDb(this.env.HYPERDRIVE.connectionString);
        try {
          const nextMessage: IntentQueueMessage = { ...message, toolInput: { ...message.toolInput, [currentField]: response.locationId } };
          const resolution = await resolveIntentLocations(db, params, { toolName: nextMessage.toolName, toolInput: nextMessage.toolInput });
          if (resolution.status === 'invalid') {
            const transitioned = await db`
              update pending_actions set status = 'cancelled', resolved_at = now()
              where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
                and user_id = ${params.userId} and kind = 'location_disambiguation' and status = 'pending'
                and missing_location_field = ${currentField} and expires_at > now()
              returning id`;
            if (transitioned.length !== 1) throw new Error('Pending location action could not be cancelled');
            return { done: true, notification: '⚠️ Transfer not possible\n\nSource and destination must be different locations.' } as const;
          }
          const resolvedMessage: IntentQueueMessage = { ...nextMessage, toolInput: resolution.toolInput };
          if (resolution.status === 'missing') {
             const transitioned = await db`
               update pending_actions set intent = ${db.json(resolvedMessage as never)}, missing_location_field = ${resolution.field}
               where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
                 and user_id = ${params.userId} and kind = 'location_disambiguation' and status = 'pending'
                 and missing_location_field = ${currentField} and expires_at > now()
               returning id`;
             if (transitioned.length !== 1) throw new Error('Pending location action could not advance');
             return { done: false, field: resolution.field, message: resolvedMessage } as const;
           }
          v.parse(IntentQueueMessageSchema, resolvedMessage);
          validateResolvedIntent(resolvedMessage);
          const transitioned = await db`
             update pending_actions set status = 'resolved', resolved_at = now(), intent = ${db.json(resolvedMessage as never)}, missing_location_field = null
             where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
               and user_id = ${params.userId} and kind = 'location_disambiguation' and status = 'pending'
               and missing_location_field = ${currentField} and expires_at > now()
             returning id`;
           if (transitioned.length !== 1) throw new Error('Pending location action could not be resolved');
          await this.env.INTENT_QUEUE.send(resolvedMessage);
          return { done: true } as const;
        } finally { await db.end(); }
      });
      if (result.done) {
        const notification = result.notification;
        if (notification) await step.do(`send invalid location ${attempt}`, () => sendMessage(this.env.TELEGRAM_BOT_TOKEN, { chatId: params.chatId, text: notification }));
        return;
      }
      message = result.message;
      field = result.field;
    }
    throw new Error('Location resolution exceeded supported fields');
  }

  private async runConfirmation(params: PendingActionWorkflowParams, message: IntentQueueMessage, step: WorkflowStep): Promise<void> {
    await step.do('send prompt', async () => {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        const [pending] = await db<{ id: string }[]>`
          select id from pending_actions
          where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
            and user_id = ${params.userId} and kind = 'confirmation' and status = 'pending' and expires_at > now()`;
        if (!pending) throw new Error('Pending confirmation is not active or owned by this workflow');
        const presentation = await loadToolPresentation(db, params.tenantId, message.toolInput);
        await sendMessage(this.env.TELEGRAM_BOT_TOKEN, { chatId: params.chatId, text: formatAdjustmentPrompt(message.toolInput, presentation, params.timeoutMinutes) });
      } finally { await db.end(); }
    });
    let received: { payload: unknown };
    try {
      received = await step.waitForEvent<WorkflowUserResponse>('wait for user response', { type: 'user-response', timeout: params.timeoutMinutes * 60_000 });
    } catch {
      await this.expire(params, step);
      return;
    }
    const response = v.parse(WorkflowUserResponseSchema, received.payload);
    const output = await step.do('resolve pending action', async () => {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        if (response.kind !== 'confirmation') throw new Error('Confirmation workflow received the wrong event kind');
        if (!response.confirmed) {
          const transitioned = await db`
            update pending_actions set status = 'cancelled', resolved_at = now()
            where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
              and user_id = ${params.userId} and kind = 'confirmation' and status = 'pending' and expires_at > now()
            returning id`;
          if (transitioned.length !== 1) throw new Error('Pending confirmation could not be cancelled');
          return null;
        }
        const output = await db.begin(async (tx) => {
          const transitioned = await tx`
            update pending_actions set status = 'confirmed', resolved_at = now()
            where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
              and user_id = ${params.userId} and kind = 'confirmation' and status = 'pending' and expires_at > now()
            returning id`;
          if (transitioned.length !== 1) throw new Error('Pending confirmation could not be confirmed');
          return executeQueuedIntent(db, message);
        });
        return output;
      } finally { await db.end(); }
    });
    if (output === null) {
      await step.do('send cancellation', () => sendMessage(this.env.TELEGRAM_BOT_TOKEN, { chatId: params.chatId, text: '❌ Adjustment cancelled\n\nStock was not changed.' }));
      return;
    }
    await step.do('send result', async () => {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        const presentation = await loadToolPresentation(db, params.tenantId, message.toolInput);
        await sendMessage(this.env.TELEGRAM_BOT_TOKEN, { chatId: params.chatId, text: formatToolResult(message.toolName, message.toolInput, output, presentation) });
        await runPostWriteEffects(db, this.env.TELEGRAM_BOT_TOKEN, message, output);
      } finally { await db.end(); }
    });
  }

  private async expire(params: PendingActionWorkflowParams, step: WorkflowStep): Promise<void> {
    await step.do('expire pending action', async () => {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        const transitioned = await db`
          update pending_actions set status = 'expired', resolved_at = now()
          where id = ${params.pendingActionId} and tenant_id = ${params.tenantId} and chat_id = ${params.chatId}
            and user_id = ${params.userId} and kind = ${params.kind} and status = 'pending'
          returning id`;
        if (transitioned.length !== 1) throw new Error('Pending action could not be expired');
      } finally { await db.end(); }
    });
    await step.do('send expiry', () => sendMessage(this.env.TELEGRAM_BOT_TOKEN, { chatId: params.chatId, text: params.kind === 'confirmation' ? '⌛ Confirmation expired\n\nStock was not changed. Repeat the command if it is still needed.' : '⌛ Location request expired\n\nRepeat the command if it is still needed.' }));
  }
}
