import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.ts';
import { consumeBatch } from '../../src/queue/intent-consumer.ts';
import { executeQueuedIntent } from '../../src/tools/execute-intent.ts';
import type { IntentQueueMessage, WriteToolName } from '../../src/types/flow.ts';
import { createTestDb } from '../support/database.ts';

const db = createTestDb();

interface Actor {
  tenantId: string;
  userId: string;
  chatId: string;
}

interface Inventory extends Actor {
  itemId: string;
  fromId: string;
  toId: string;
}

async function actor(): Promise<Actor> {
  const chatId = `-${crypto.randomUUID()}`;
  const [tenant] = await db<{ id: string }[]>`insert into tenants (name) values (${crypto.randomUUID()}) returning id`;
  const [user] = await db<{ id: string }[]>`insert into users (tenant_id, telegram_user_id) values (${tenant.id}, ${crypto.randomUUID()}) returning id`;
  await db`insert into telegram_chats (chat_id, tenant_id) values (${chatId}, ${tenant.id})`;
  return { tenantId: tenant.id, userId: user.id, chatId };
}

async function inventory(quantity = 10): Promise<Inventory> {
  const owner = await actor();
  const [from] = await db<{ id: string }[]>`insert into locations (tenant_id, name, type) values (${owner.tenantId}, 'Warehouse', 'physical') returning id`;
  const [to] = await db<{ id: string }[]>`insert into locations (tenant_id, name, type) values (${owner.tenantId}, 'Store', 'physical') returning id`;
  const [item] = await db<{ id: string }[]>`insert into items (tenant_id, name, base_unit) values (${owner.tenantId}, 'Indomie', 'pcs') returning id`;
  if (quantity) await db`insert into stock_levels (item_id, location_id, quantity) values (${item.id}, ${from.id}, ${quantity})`;
  return { ...owner, itemId: item.id, fromId: from.id, toId: to.id };
}

function intent(owner: Actor, toolName: WriteToolName, toolInput: Record<string, unknown>, id = crypto.randomUUID()): IntentQueueMessage {
  return {
    id,
    tenantId: owner.tenantId,
    chatId: owner.chatId,
    userId: owner.userId,
    toolName,
    toolInput: { tenantId: owner.tenantId, chatId: owner.chatId, userId: owner.userId, ...toolInput },
    requiresConfirmation: toolName === 'adjust_stock',
    enqueuedAt: new Date().toISOString(),
  };
}

async function receiptCount(message: IntentQueueMessage): Promise<number> {
  const [row] = await db<{ count: number }[]>`select count(*)::int count from intent_executions where tenant_id = ${message.tenantId} and intent_id = ${message.id}`;
  return row.count;
}

beforeEach(async () => { await db`truncate tenants cascade`; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await db.end(); });

describe('queued intent idempotency', () => {
  it('commits concurrent duplicate add_stock once', async () => {
    const s = await inventory();
    const message = intent(s, 'add_stock', { itemNameOrId: s.itemId, locationId: s.fromId, quantity: 4 });
    const outputs = await Promise.all(Array.from({ length: 8 }, () => executeQueuedIntent(db, message)));
    for (const output of outputs) expect(output).toEqual(outputs[0]);
    const [level] = await db<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    const [ledger] = await db<{ count: number }[]>`select count(*)::int count from stock_transactions where tenant_id = ${s.tenantId}`;
    expect(level.quantity).toBe(14);
    expect(ledger.count).toBe(1);
    expect(await receiptCount(message)).toBe(1);
  });

  it('replays offline removal without another decrement', async () => {
    const s = await inventory();
    const message = intent(s, 'remove_stock', { itemNameOrId: s.itemId, locationId: s.fromId, quantity: 3, source: 'offline' });
    const first = await executeQueuedIntent(db, message);
    expect(await executeQueuedIntent(db, message)).toEqual(first);
    const [level] = await db<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    const [ledger] = await db<{ count: number }[]>`select count(*)::int count from stock_transactions where tenant_id = ${s.tenantId}`;
    expect(level.quantity).toBe(7);
    expect(ledger.count).toBe(1);
  });

  it('replays one transfer with exactly two ledger legs', async () => {
    const s = await inventory();
    const message = intent(s, 'transfer_stock', { itemNameOrId: s.itemId, fromLocationId: s.fromId, toLocationId: s.toId, quantity: 4 });
    const first = await executeQueuedIntent(db, message);
    expect(await executeQueuedIntent(db, message)).toEqual(first);
    const levels = await db<{ location_id: string; quantity: number }[]>`select location_id, quantity from stock_levels where item_id = ${s.itemId} order by location_id`;
    const transactions = await db<{ quantity: number }[]>`select quantity from stock_transactions where tenant_id = ${s.tenantId} and type = 'transfer'`;
    expect(levels).toEqual(expect.arrayContaining([{ location_id: s.fromId, quantity: 6 }, { location_id: s.toId, quantity: 4 }]));
    expect(transactions).toHaveLength(2);
    expect(transactions.reduce((sum, row) => sum + row.quantity, 0)).toBe(0);
  });

  it('replays a confirmed adjustment without another ledger row', async () => {
    const s = await inventory();
    const message = intent(s, 'adjust_stock', { itemNameOrId: s.itemId, locationId: s.fromId, newQuantity: 4, reason: 'count' });
    const first = await executeQueuedIntent(db, message);
    expect(await executeQueuedIntent(db, message)).toEqual(first);
    const [level] = await db<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    const [ledger] = await db<{ count: number }[]>`select count(*)::int count from stock_transactions where tenant_id = ${s.tenantId} and type = 'adjustment'`;
    expect(level.quantity).toBe(4);
    expect(ledger.count).toBe(1);
  });

  it('replays location and item creation with original IDs', async () => {
    const s = await actor();
    const locationMessage = intent(s, 'create_location', { name: 'Store', type: 'physical' });
    const location = await executeQueuedIntent(db, locationMessage);
    expect(await executeQueuedIntent(db, locationMessage)).toEqual(location);
    const itemMessage = intent(s, 'create_item', { name: 'Soap', baseUnit: 'pcs', units: [{ unitName: 'box', conversionToBase: 12 }] });
    const item = await executeQueuedIntent(db, itemMessage);
    expect(await executeQueuedIntent(db, itemMessage)).toEqual(item);
    const [counts] = await db<{ locations: number; items: number; units: number }[]>`select (select count(*)::int from locations) locations, (select count(*)::int from items) items, (select count(*)::int from item_units) units`;
    expect(counts).toEqual({ locations: 1, items: 1, units: 1 });
  });

  it('scopes the same intent UUID independently by tenant', async () => {
    const first = await inventory();
    const second = await inventory();
    const id = crypto.randomUUID();
    await executeQueuedIntent(db, intent(first, 'add_stock', { itemNameOrId: first.itemId, locationId: first.fromId, quantity: 2 }, id));
    await executeQueuedIntent(db, intent(second, 'add_stock', { itemNameOrId: second.itemId, locationId: second.fromId, quantity: 7 }, id));
    const [receipts] = await db<{ count: number }[]>`select count(*)::int count from intent_executions where intent_id = ${id}`;
    expect(receipts.count).toBe(2);
  });

  it('replays set_reorder_threshold from its stored output', async () => {
    const s = await inventory();
    const message = intent(s, 'set_reorder_threshold', { itemNameOrId: s.itemId, locationId: s.fromId, threshold: 6 });
    const first = await executeQueuedIntent(db, message);
    expect(await executeQueuedIntent(db, message)).toEqual(first);
    const [level] = await db<{ reorder_threshold: number }[]>`select reorder_threshold from stock_levels where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    expect(level.reorder_threshold).toBe(6);
    expect(await receiptCount(message)).toBe(1);
  });

  it('retries Telegram delivery without repeating the committed mutation', async () => {
    const s = await inventory();
    const message = intent(s, 'add_stock', { itemNameOrId: s.itemId, locationId: s.fromId, quantity: 4 });
    const first = { body: message, ack: vi.fn(), retry: vi.fn() };
    const second = { body: message, ack: vi.fn(), retry: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })));
    const env = { HYPERDRIVE: { connectionString: process.env.TEST_DATABASE_URL }, TELEGRAM_BOT_TOKEN: 'token' } as never;
    await consumeBatch({ messages: [first] } as never, env);
    expect(first.retry).toHaveBeenCalledOnce();
    await consumeBatch({ messages: [second] } as never, env);
    expect(second.ack).toHaveBeenCalledOnce();
    const [level] = await db<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    const [ledger] = await db<{ count: number }[]>`select count(*)::int count from stock_transactions where tenant_id = ${s.tenantId}`;
    expect(level.quantity).toBe(14);
    expect(ledger.count).toBe(1);
  });

  it('rolls back the receipt when tool execution fails', async () => {
    const s = await actor();
    const message = intent(s, 'add_stock', { itemNameOrId: crypto.randomUUID(), locationId: crypto.randomUUID(), quantity: 1 });
    await expect(executeQueuedIntent(db, message)).rejects.toThrow('Item not found');
    expect(await receiptCount(message)).toBe(0);
  });

  it('rejects an envelope and tool context mismatch', async () => {
    const first = await actor();
    const second = await actor();
    const message = intent(first, 'create_location', { tenantId: second.tenantId, name: 'Store', type: 'physical' });
    await expect(executeQueuedIntent(db, message)).rejects.toThrow('Intent envelope and tool context do not match');
    expect(await receiptCount(message)).toBe(0);
  });
});
