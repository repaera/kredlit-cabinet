import * as v from 'valibot';
import type { Env } from '../env.ts';
import { resolveProvider } from './provider.ts';

const ParsedIntentSchema = v.object({
  toolName: v.picklist(['create_location', 'create_item', 'check_stock', 'add_stock', 'remove_stock', 'transfer_stock', 'adjust_stock', 'set_reorder_threshold', 'list_low_stock', 'get_item_history', 'export_stock_report']),
  toolInput: v.record(v.string(), v.unknown()),
});
export type ParsedIntent = v.InferOutput<typeof ParsedIntentSchema>;
const ParsedIntentsSchema = v.union([ParsedIntentSchema, v.array(ParsedIntentSchema)]);

function jsonFromText(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return JSON.parse(fenced?.[1] ?? text);
}

export async function parseIntent(env: Env, text: string, locations: { id: string; name: string }[]): Promise<ParsedIntent[]> {
  const prompt = `Return only a JSON array of {"toolName": string, "toolInput": object} using these contracts:
create_location {name,type:"physical"|"own_website"|"marketplace"}; infer Website as own_website, Shopee/Tokopedia/TikTok Shop/Lazada as marketplace, otherwise physical.
create_item {name,baseUnit,defaultReorderThreshold?,units?:[{unitName,conversionToBase}]}.
check_stock {itemNameOrId,locationId?}.
add_stock {itemNameOrId,locationId?,quantity,unit?,metadata?}.
remove_stock {itemNameOrId,locationId?,quantity,unit?,source:"offline"|"online"|"marketplace",externalOrderId?}; externalOrderId is required for online/marketplace.
transfer_stock {itemNameOrId,fromLocationId,toLocationId,quantity,unit?}.
adjust_stock {itemNameOrId,locationId?,newQuantity,unit?,reason}.
set_reorder_threshold {itemNameOrId,locationId?,threshold}.
list_low_stock {locationId?}. get_item_history {itemNameOrId?,locationId?,dateFrom?,dateTo?}. export_stock_report {locationId?,itemNameOrId?,dateFrom?,dateTo?}.
Return multiple calls when one message creates multiple locations. Preserve quantities, units, reasons, sources, and order IDs. Use location IDs from this JSON when named: ${JSON.stringify(locations)}. Omit locationId when no location is stated. User message: ${JSON.stringify(text)}`;
  const provider = resolveProvider(env);
  let responseText: string;
  if (provider.kind === 'workers-ai') {
    const result = await provider.binding.run(provider.model as keyof AiModels, { prompt }) as unknown as { response?: string } | string;
    responseText = typeof result === 'string' ? result : result.response ?? '';
  } else {
    const response = await fetch(provider.url, { method: 'POST', headers: provider.headers, body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: prompt }] }) });
    if (!response.ok) throw new Error(`AI Gateway failed: ${response.status}`);
    const result = await response.json() as { choices?: { message?: { content?: string } }[] };
    responseText = result.choices?.[0]?.message?.content ?? '';
  }
  const parsed = v.parse(ParsedIntentsSchema, jsonFromText(responseText));
  return Array.isArray(parsed) ? parsed : [parsed];
}
