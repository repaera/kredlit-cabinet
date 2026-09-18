import { Hono } from 'hono';
import * as v from 'valibot';
import { createDb } from '../db/client.ts';
import type { Env } from '../env.ts';
import { link, start } from './commands.ts';
import { decodeLocationCallback } from '../lib/callback-data.ts';
import { classifyConfirmation } from '../lib/confirm-classifier.ts';
import { rememberLocation, resolveIntentLocations } from '../lib/location-resolution.ts';
import { parseIntent } from '../llm/parse-intent.ts';
import { answerCallbackQuery, editMessageReplyMarkup, sendDocument, sendMessage } from '../telegram/client.ts';
import { formatReportCaption, formatToolResult } from '../telegram/messages.ts';
import { TelegramUpdateSchema } from '../telegram/webhook-schema.ts';
import { checkStock, exportStockReport, getItemHistory, listLowStock } from '../tools/execute.ts';
import { requiresConfirmation } from '../lib/requires-confirmation.ts';

export function createApp(intentParser: typeof parseIntent = parseIntent) {
const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

app.post('/telegram/webhook', async (c) => {
  if (c.req.header('X-Telegram-Bot-Api-Secret-Token') !== c.env.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: 'unauthorized' }, 401);
  const parsed = v.safeParse(TelegramUpdateSchema, await c.req.json());
  if (!parsed.success) return c.json({ error: 'invalid_update' }, 400);
  const update = parsed.output;
  const chatId = String(update.callback_query?.message.chat.id ?? update.message?.chat.id ?? '');
  const limited = await c.env.TELEGRAM_RATE_LIMITER.limit({ key: chatId });
  if (!limited.success) return c.json({ error: 'rate_limited' }, 429);

  const db = createDb(c.env.HYPERDRIVE.connectionString);
  try {
    if (update.callback_query) {
      const callback = decodeLocationCallback(update.callback_query.data);
      let error: string | undefined;
      try {
        if (!callback) {
          error = 'invalid_callback';
        } else {
          const [pending] = await db<{ workflow_instance_id: string; tenant_id: string }[]>`
            select pa.workflow_instance_id, pa.tenant_id from pending_actions pa join users u on u.id = pa.user_id
            where pa.id = ${callback.pendingActionId} and pa.status = 'pending' and pa.expires_at > now()
              and pa.chat_id = ${chatId} and u.telegram_user_id = ${String(update.callback_query.from.id)}
              and pa.missing_location_field = ${callback.field}`;
          if (!pending) {
            error = 'expired_or_unknown_callback';
          } else {
            const locations = await db<{ id: string }[]>`
              select id from locations where id::text like ${callback.locationShortId + '%'} and tenant_id = ${pending.tenant_id} limit 2`;
            if (locations.length !== 1) {
              error = 'invalid_location';
            } else {
              const instance = await c.env.PENDING_ACTION_WORKFLOW.get(pending.workflow_instance_id);
              await instance.sendEvent({ type: 'user-response', payload: { kind: 'location_disambiguation', field: callback.field, locationId: locations[0].id } });
            }
          }
        }
      } finally {
        await answerCallbackQuery(c.env.TELEGRAM_BOT_TOKEN, update.callback_query.id);
        if (callback) await editMessageReplyMarkup(c.env.TELEGRAM_BOT_TOKEN, chatId, update.callback_query.message.message_id);
      }
      return c.json(error ? { ok: false, error } : { ok: true });
    }

    const message = update.message;
    if (!message?.text) return c.json({ ok: true });
    const telegramUserId = String(message.from.id);
    const [rawCommand, ...commandArgs] = message.text.trim().split(/\s+/);
    const command = rawCommand.split('@', 1)[0];
    if (command === '/start') {
      const reply = await start(db, chatId, telegramUserId, message.from.first_name, message.chat.title);
      await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: reply });
      return c.json({ ok: true });
    }
    if (command === '/link' && commandArgs.length) {
      const reply = await link(db, chatId, telegramUserId, commandArgs.join(' '));
      await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: reply });
      return c.json({ ok: true });
    }

    const [actor] = await db<{ user_id: string; tenant_id: string }[]>`
      select u.id user_id, tc.tenant_id from telegram_chats tc join users u on u.tenant_id = tc.tenant_id
      where tc.chat_id = ${chatId} and u.telegram_user_id = ${telegramUserId}`;
    if (!actor) {
      await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: '👋 Welcome\n\nRun /start in this group first.' });
      return c.json({ ok: true });
    }
    const [pending] = await db<{ id: string; kind: 'confirmation' | 'location_disambiguation'; workflow_instance_id: string; missing_location_field: 'locationId' | 'fromLocationId' | 'toLocationId' | null }[]>`
      select id, kind, workflow_instance_id, missing_location_field from pending_actions
      where chat_id = ${chatId} and user_id = ${actor.user_id} and status = 'pending' and expires_at > now()`;
    if (pending?.kind === 'confirmation') {
      const classification = classifyConfirmation(message.text);
      if (classification === 'UNCLEAR') {
        await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: '❓ Please confirm\n\nReply yes to proceed or cancel.' });
      } else {
        const instance = await c.env.PENDING_ACTION_WORKFLOW.get(pending.workflow_instance_id);
        await instance.sendEvent({ type: 'user-response', payload: { kind: 'confirmation', confirmed: classification === 'CONFIRM' } });
      }
      return c.json({ ok: true });
    }
    if (pending?.kind === 'location_disambiguation') {
      const matches = await db<{ id: string }[]>`select id from locations where tenant_id = ${actor.tenant_id} and position(lower(name) in lower(${message.text})) > 0`;
      if (matches.length === 1 && pending.missing_location_field) {
        const instance = await c.env.PENDING_ACTION_WORKFLOW.get(pending.workflow_instance_id);
        await instance.sendEvent({ type: 'user-response', payload: { kind: 'location_disambiguation', field: pending.missing_location_field, locationId: matches[0].id } });
      } else {
        await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: '📍 Location needed\n\nPlease tap one of the location buttons.' });
      }
      return c.json({ ok: true });
    }

    const locations = await db<{ id: string; name: string }[]>`select id, name from locations where tenant_id = ${actor.tenant_id}`;
    const intents = await intentParser(c.env, message.text, locations);
    for (const intent of intents) {
      const resolution = await resolveIntentLocations(db, { tenantId: actor.tenant_id, chatId, userId: actor.user_id }, intent, message.text);
      if (resolution.status === 'invalid') {
        await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: resolution.reason === 'same_location' ? '⚠️ Transfer not possible\n\nSource and destination must be different locations.' : '⚠️ Location not found\n\nChoose a location that belongs to this inventory.' });
        continue;
      }
      const toolInput: Record<string, unknown> = { ...resolution.toolInput, tenantId: actor.tenant_id, chatId, userId: actor.user_id };
      if (resolution.status === 'missing') {
        const queued = { id: crypto.randomUUID(), tenantId: actor.tenant_id, chatId, userId: actor.user_id, toolName: intent.toolName, toolInput, requiresConfirmation: requiresConfirmation(intent.toolName), enqueuedAt: new Date().toISOString() };
        const pendingId = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
        const [tenant] = await db<{ settings: { confirmTimeoutMinutes?: number } }[]>`select settings from tenants where id = ${actor.tenant_id}`;
        const timeoutMinutes = tenant.settings.confirmTimeoutMinutes ?? 10;
        try {
          await db`insert into pending_actions (id, tenant_id, chat_id, user_id, kind, intent, missing_location_field, workflow_instance_id, expires_at) values (${pendingId}, ${actor.tenant_id}, ${chatId}, ${actor.user_id}, 'location_disambiguation', ${db.json(queued as never)}, ${resolution.field}, ${pendingId}, now() + ${timeoutMinutes + ' minutes'}::interval)`;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: '⏳ Action pending\n\nPlease resolve your current confirmation first.' });
            return c.json({ ok: true });
          }
          throw error;
        }
        await c.env.PENDING_ACTION_WORKFLOW.create({ id: pendingId, params: { pendingActionId: pendingId, tenantId: actor.tenant_id, chatId, userId: actor.user_id, kind: 'location_disambiguation', intent: queued as unknown as Record<string, unknown>, missingLocationField: resolution.field, timeoutMinutes } });
        continue;
      }
      if (intent.toolName === 'check_stock') {
        await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: formatToolResult(intent.toolName, toolInput, await checkStock(db, toolInput)) });
      } else if (intent.toolName === 'list_low_stock') {
        await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: formatToolResult(intent.toolName, toolInput, await listLowStock(db, toolInput)) });
      } else if (intent.toolName === 'get_item_history') {
        await sendMessage(c.env.TELEGRAM_BOT_TOKEN, { chatId, text: formatToolResult(intent.toolName, toolInput, await getItemHistory(db, toolInput)) });
      } else if (intent.toolName === 'export_stock_report') {
        const report = await exportStockReport(db, toolInput);
        await sendDocument(c.env.TELEGRAM_BOT_TOKEN, { chatId, fileName: report.fileName, fileBytes: report.fileBytes, caption: formatReportCaption(report.rowCount, report.rangeUsed.from, report.rangeUsed.to, report.clamped) });
      } else {
        const queued = { id: crypto.randomUUID(), tenantId: actor.tenant_id, chatId, userId: actor.user_id, toolName: intent.toolName, toolInput, requiresConfirmation: requiresConfirmation(intent.toolName), enqueuedAt: new Date().toISOString() };
        await c.env.INTENT_QUEUE.send(queued);
      }
      const usedLocation = typeof toolInput.locationId === 'string' ? toolInput.locationId : typeof toolInput.fromLocationId === 'string' ? toolInput.fromLocationId : undefined;
      if (usedLocation && ['check_stock', 'list_low_stock', 'get_item_history', 'export_stock_report'].includes(intent.toolName)) await rememberLocation(db, chatId, actor.user_id, usedLocation);
    }
    return c.json({ ok: true }, 202);
  } finally {
    await db.end();
  }
});

return app;
}

const app = createApp();
export default app;
