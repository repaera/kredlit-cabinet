import * as v from 'valibot';
import type { Db } from '../db/client.ts';
import {
  AddStockInputSchema, AddStockOutputSchema, AdjustStockInputSchema, AdjustStockOutputSchema,
  CheckStockOutputSchema, CreateItemInputSchema, CreateItemOutputSchema, CreateLocationOutputSchema,
  GetItemHistoryOutputSchema, ListLowStockOutputSchema, RemoveStockInputSchema, RemoveStockOutputSchema,
  SetReorderThresholdInputSchema, SetReorderThresholdOutputSchema, TransferStockInputSchema, TransferStockOutputSchema,
} from '../types/tools.ts';

export interface ToolPresentation {
  itemName?: string;
  baseUnit?: string;
  locationName?: string;
  fromLocationName?: string;
  toLocationName?: string;
}

function field(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = Reflect.get(input, name);
  return typeof value === 'string' ? value : undefined;
}

function number(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(value);
}

function typeLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function quantity(value: number, unit: string): string {
  return `${number(value)} ${unit}`;
}

export async function loadToolPresentation(db: Db, tenantId: string, input: unknown): Promise<ToolPresentation> {
  const itemNameOrId = field(input, 'itemNameOrId');
  const [item] = itemNameOrId ? await db<{ name: string; base_unit: string }[]>`
    select name, base_unit from items
    where tenant_id = ${tenantId} and (id::text = ${itemNameOrId} or lower(name) = lower(${itemNameOrId}))
    limit 1` : [];
  const locationFields = ['locationId', 'fromLocationId', 'toLocationId'] as const;
  const ids = locationFields.map((name) => field(input, name)).filter((id): id is string => Boolean(id));
  const locations = ids.length ? await db<{ id: string; name: string }[]>`
    select id, name from locations where tenant_id = ${tenantId} and id in ${db(ids)}` : [];
  const locationName = (name: typeof locationFields[number]) => locations.find((location) => location.id === field(input, name))?.name;
  return {
    itemName: item?.name ?? itemNameOrId,
    baseUnit: item?.base_unit,
    locationName: locationName('locationId'),
    fromLocationName: locationName('fromLocationId'),
    toLocationName: locationName('toLocationId'),
  };
}

export function formatToolResult(toolName: string, input: unknown, output: unknown, presentation: ToolPresentation = {}): string {
  switch (toolName) {
    case 'create_location': {
      const result = v.parse(CreateLocationOutputSchema, output);
      return `📍 Location added\n\n${result.name}\nType: ${typeLabel(result.type)}`;
    }
    case 'create_item': {
      const data = v.parse(CreateItemInputSchema, input);
      const result = v.parse(CreateItemOutputSchema, output);
      const details = [`Base unit: ${result.baseUnit}`];
      if (data.defaultReorderThreshold !== undefined) details.push(`Reorder threshold: ${number(data.defaultReorderThreshold)} ${result.baseUnit}`);
      if (data.units?.length) details.push(`Units: ${data.units.map((unit) => `1 ${unit.unitName} = ${number(unit.conversionToBase)} ${result.baseUnit}`).join(', ')}`);
      return `📦 Item created\n\n${result.name}\n${details.join('\n')}`;
    }
    case 'add_stock': {
      const data = v.parse(AddStockInputSchema, input);
      const result = v.parse(AddStockOutputSchema, output);
      const baseUnit = presentation.baseUnit ?? 'base units';
      return `✅ Stock added\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nLocation: ${presentation.locationName ?? 'Selected location'}\nReceived: ${quantity(data.quantity, data.unit ?? baseUnit)}\nNew total: ${quantity(result.newQuantity, baseUnit)}`;
    }
    case 'remove_stock': {
      const data = v.parse(RemoveStockInputSchema, input);
      const result = v.parse(RemoveStockOutputSchema, output);
      const baseUnit = presentation.baseUnit ?? 'base units';
      if (!result.ok && result.error === 'insufficient_stock') return `⚠️ Insufficient stock\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nRequested: ${quantity(data.quantity, data.unit ?? baseUnit)}\nAvailable: ${quantity(result.availableQuantity, baseUnit)}`;
      if (!result.ok) return `ℹ️ Order already recorded\n\nOrder: ${data.externalOrderId ?? 'Unknown'}\nStock was not changed again.`;
      const title = data.source === 'offline' ? '✅ Sale recorded' : '✅ Order recorded';
      return `${title}\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nLocation: ${presentation.locationName ?? 'Selected location'}\nRemoved: ${quantity(data.quantity, data.unit ?? baseUnit)}\nRemaining: ${quantity(result.newQuantity, baseUnit)}${data.externalOrderId ? `\nOrder: ${data.externalOrderId}` : ''}`;
    }
    case 'transfer_stock': {
      const data = v.parse(TransferStockInputSchema, input);
      const result = v.parse(TransferStockOutputSchema, output);
      const baseUnit = presentation.baseUnit ?? 'base units';
      if (!result.ok) return `⚠️ Transfer not completed\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nRequested: ${quantity(data.quantity, data.unit ?? baseUnit)}\nAvailable: ${quantity(result.availableQuantity, baseUnit)}`;
      return `🔄 Stock transferred\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nMoved: ${quantity(data.quantity, data.unit ?? baseUnit)}\nFrom: ${presentation.fromLocationName ?? 'Source'} (${quantity(result.fromNewQuantity, baseUnit)} left)\nTo: ${presentation.toLocationName ?? 'Destination'} (${quantity(result.toNewQuantity, baseUnit)} total)`;
    }
    case 'adjust_stock': {
      const data = v.parse(AdjustStockInputSchema, input);
      const result = v.parse(AdjustStockOutputSchema, output);
      const baseUnit = presentation.baseUnit ?? data.unit ?? 'base units';
      const change = result.delta > 0 ? `+${number(result.delta)}` : number(result.delta);
      return `✅ Stock adjusted\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nLocation: ${presentation.locationName ?? 'Selected location'}\nPrevious: ${quantity(result.oldQuantity, baseUnit)}\nNew total: ${quantity(result.newQuantity, baseUnit)}\nChange: ${change} ${baseUnit}\nReason: ${data.reason}`;
    }
    case 'set_reorder_threshold': {
      const data = v.parse(SetReorderThresholdInputSchema, input);
      const result = v.parse(SetReorderThresholdOutputSchema, output);
      return `🔔 Reorder threshold set\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nScope: ${result.locationId ? presentation.locationName ?? 'Selected location' : 'All locations (default)'}\nThreshold: ${quantity(result.threshold, presentation.baseUnit ?? 'base units')}`;
    }
    case 'check_stock': {
      const result = v.parse(CheckStockOutputSchema, output);
      if (!result.levels.length) return `📦 ${result.item.name}\n\nNo stock locations found.`;
      const lines = result.levels.map((level) => `• ${level.locationName}: ${quantity(level.quantity, result.item.baseUnit)}${level.displayUnit ? ` (${quantity(level.displayUnit.quantity, level.displayUnit.unitName)})` : ''}`);
      return `📦 ${result.item.name} stock\n\n${lines.join('\n')}`;
    }
    case 'list_low_stock': {
      const result = v.parse(ListLowStockOutputSchema, output);
      if (!result.items.length) return '✅ No low-stock items.';
      return `⚠️ Low stock\n\n${result.items.map((item) => `• ${item.itemName} at ${item.locationName}: ${number(item.quantity)} (threshold ${number(item.threshold)})`).join('\n')}`;
    }
    case 'get_item_history': {
      const result = v.parse(GetItemHistoryOutputSchema, output);
      if (!result.transactions.length) return '🧾 No inventory history found for that range.';
      const lines = result.transactions.slice(0, 20).map((transaction) => {
        const source = transaction.source ? ` · ${typeLabel(transaction.source)}` : '';
        return `• ${transaction.createdAt.slice(0, 10)} · ${typeLabel(transaction.type)} · ${transaction.quantity > 0 ? '+' : ''}${number(transaction.quantity)}${source}`;
      });
      const remaining = result.transactions.length - lines.length;
      return `🧾 Inventory history\n\n${lines.join('\n')}${remaining > 0 ? `\n\n…and ${remaining} more.` : ''}`;
    }
    default:
      throw new Error(`No Telegram formatter for tool: ${toolName}`);
  }
}

export function formatAdjustmentPrompt(input: unknown, presentation: ToolPresentation, timeoutMinutes: number): string {
  const data = v.parse(AdjustStockInputSchema, input);
  return `⚠️ Confirm stock adjustment\n\nItem: ${presentation.itemName ?? data.itemNameOrId}\nLocation: ${presentation.locationName ?? 'Selected location'}\nSet stock to: ${quantity(data.newQuantity, data.unit ?? presentation.baseUnit ?? 'base units')}\nReason: ${data.reason}\n\nReply yes to proceed or cancel. Expires in ${number(timeoutMinutes)} minutes.`;
}

export function formatReportCaption(rowCount: number, from: string, to: string, clamped: boolean): string {
  return `📊 Stock report\n${number(rowCount)} transactions\n${from.slice(0, 10)} to ${to.slice(0, 10)}${clamped ? '\nRange limited to the latest 90 days.' : ''}`;
}

export function formatLowStockAlert(input: { itemName: string; locationName: string; quantity: number; baseUnit: string; threshold: number; operation: string }): string {
  return `⚠️ Low stock\n\n${input.itemName} at ${input.locationName}\nRemaining: ${quantity(input.quantity, input.baseUnit)}\nThreshold: ${quantity(input.threshold, input.baseUnit)}\nAfter: ${typeLabel(input.operation)}`;
}
