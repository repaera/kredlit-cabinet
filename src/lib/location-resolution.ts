import type { Db } from '../db/client.ts';
import type { ParsedIntent } from '../llm/parse-intent.ts';
import type { LocationField } from '../types/flow.ts';

type Location = { id: string; name: string };
export type LocationResolution =
  | { status: 'resolved'; toolInput: Record<string, unknown> }
  | { status: 'missing'; field: LocationField; toolInput: Record<string, unknown> }
  | { status: 'invalid'; reason: 'same_location' | 'invalid_location' };

const singleLocationTools = new Set(['add_stock', 'remove_stock', 'adjust_stock']);
const optionalLocationTools = new Set(['check_stock', 'list_low_stock', 'get_item_history', 'export_stock_report', 'set_reorder_threshold']);

function explicitLocation(value: unknown, locations: Location[]): Location | null {
  if (typeof value !== 'string') return null;
  const matches = locations.filter((location) => location.id === value || location.name.toLocaleLowerCase() === value.toLocaleLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

function namedLocations(text: string | undefined, locations: Location[]): Location[] {
  if (!text) return [];
  const normalized = text.toLocaleLowerCase();
  const matches = locations.filter((location) => normalized.includes(location.name.toLocaleLowerCase()));
  const longest = Math.max(0, ...matches.map((location) => location.name.length));
  return matches.filter((location) => location.name.length === longest);
}

export async function resolveIntentLocations(
  db: Db,
  context: { tenantId: string; chatId: string; userId: string },
  intent: ParsedIntent,
  text?: string,
): Promise<LocationResolution> {
  const locations = await db<Location[]>`select id, name from locations where tenant_id = ${context.tenantId} order by name, id`;
  const [linked] = await db<Location[]>`
    select l.id, l.name from telegram_chats tc join locations l on l.id = tc.location_id and l.tenant_id = tc.tenant_id
    where tc.chat_id = ${context.chatId} and tc.tenant_id = ${context.tenantId}`;
  const [remembered] = await db<Location[]>`
    select l.id, l.name from session_context sc join locations l on l.id = sc.last_location_id
    join users u on u.id = sc.user_id and u.tenant_id = l.tenant_id
    where sc.chat_id = ${context.chatId} and sc.user_id = ${context.userId} and l.tenant_id = ${context.tenantId}`;
  const toolInput = { ...intent.toolInput };

  if (singleLocationTools.has(intent.toolName)) {
    const supplied = toolInput.locationId !== undefined;
    const explicit = explicitLocation(toolInput.locationId, locations);
    const named = namedLocations(text, locations);
    if (!linked && (named.length > 1 || named.length === 0 && supplied && !explicit)) return { status: 'missing', field: 'locationId', toolInput };
    const location = linked ?? named[0] ?? explicit ?? remembered;
    if (!location) return { status: 'missing', field: 'locationId', toolInput };
    toolInput.locationId = location.id;
    return { status: 'resolved', toolInput };
  }

  if (intent.toolName === 'transfer_stock') {
    const suppliedFrom = toolInput.fromLocationId !== undefined;
    const explicitFrom = explicitLocation(toolInput.fromLocationId, locations);
    if (suppliedFrom && !explicitFrom) return { status: 'missing', field: 'fromLocationId', toolInput };
    const from = explicitFrom ?? linked ?? remembered;
    if (!from) return { status: 'missing', field: 'fromLocationId', toolInput };
    toolInput.fromLocationId = from.id;
    const to = explicitLocation(toolInput.toLocationId, locations);
    if (!to) return { status: 'missing', field: 'toLocationId', toolInput };
    if (from.id === to.id) return { status: 'invalid', reason: 'same_location' };
    toolInput.toLocationId = to.id;
    return { status: 'resolved', toolInput };
  }

  if (optionalLocationTools.has(intent.toolName) && toolInput.locationId !== undefined) {
    const location = explicitLocation(toolInput.locationId, locations);
    if (!location) return { status: 'invalid', reason: 'invalid_location' };
    toolInput.locationId = location.id;
  }
  return { status: 'resolved', toolInput };
}

export async function rememberLocation(db: Db, chatId: string, userId: string, locationId: string): Promise<void> {
  await db`insert into session_context (chat_id, user_id, last_location_id) values (${chatId}, ${userId}, ${locationId}) on conflict (chat_id, user_id) do update set last_location_id = excluded.last_location_id, updated_at = now()`;
}
