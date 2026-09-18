import type { Db } from '../db/client.ts';
import { sendMessage } from '../telegram/client.ts';
import { formatLowStockAlert } from '../telegram/messages.ts';
import type { IntentQueueMessage } from '../types/flow.ts';
import type { WriteToolOutput } from '../types/tools.ts';

function value(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === 'string' ? input[key] : undefined;
}

export async function runPostWriteEffects(db: Db, token: string, message: IntentQueueMessage, output: WriteToolOutput): Promise<void> {
  const locationId = message.toolName === 'transfer_stock' ? value(message.toolInput, 'fromLocationId') : value(message.toolInput, 'locationId');
  const itemNameOrId = value(message.toolInput, 'itemNameOrId');
  const result = output as { ok?: boolean; newQuantity?: number; fromNewQuantity?: number; delta?: number };
  if (result.ok !== false && locationId) await db`insert into session_context (chat_id, user_id, last_location_id) values (${message.chatId}, ${message.userId}, ${locationId}) on conflict (chat_id, user_id) do update set last_location_id = excluded.last_location_id, updated_at = now()`;
  const quantity = message.toolName === 'transfer_stock' && result.ok ? result.fromNewQuantity : message.toolName === 'remove_stock' && result.ok ? result.newQuantity : message.toolName === 'adjust_stock' && (result.delta ?? 0) < 0 ? result.newQuantity : undefined;
  if (quantity === undefined || !locationId || !itemNameOrId) return;
  const [stock] = await db<{ item_name: string; base_unit: string; location_name: string; threshold: number | null }[]>`
    select i.name item_name, i.base_unit, l.name location_name, coalesce(sl.reorder_threshold, i.default_reorder_threshold)::int threshold
    from items i join locations l on l.tenant_id = i.tenant_id join stock_levels sl on sl.item_id = i.id and sl.location_id = l.id
    where i.tenant_id = ${message.tenantId} and (i.id::text = ${itemNameOrId} or lower(i.name) = lower(${itemNameOrId})) and l.id = ${locationId}`;
  if (stock?.threshold === null || stock === undefined || quantity >= stock.threshold) return;
  let chats: { chat_id: string }[] = [...await db<{ chat_id: string }[]>`select distinct chat_id from telegram_chats where tenant_id = ${message.tenantId} and location_id = ${locationId}`];
  if (!chats.length) chats = [...await db<{ chat_id: string }[]>`select distinct chat_id from telegram_chats where tenant_id = ${message.tenantId} and location_id is null`];
  const operation = message.toolName === 'remove_stock' ? 'sale' : message.toolName === 'transfer_stock' ? 'transfer' : 'downward_adjustment';
  const text = formatLowStockAlert({ itemName: stock.item_name, locationName: stock.location_name, quantity, baseUnit: stock.base_unit, threshold: stock.threshold, operation });
  for (const chat of chats) await sendMessage(token, { chatId: chat.chat_id, text });
}
