import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.ts';
import { runPostWriteEffects } from '../../src/lib/post-write-effects.ts';
import { adjustStock, removeStock, transferStock } from '../../src/tools/execute.ts';
import type { IntentQueueMessage, WriteToolName } from '../../src/types/flow.ts';
import type { WriteToolOutput } from '../../src/types/tools.ts';
import { createTestDb } from '../support/database.ts';

const db = createTestDb();

interface Seed {
  tenantId: string;
  userId: string;
  chatId: string;
  itemId: string;
  fromId: string;
  toId: string;
}

async function seed(quantity = 6, threshold = 5): Promise<Seed> {
  const chatId = `-${crypto.randomUUID()}`;
  const [tenant] = await db<{ id: string }[]>`insert into tenants (name) values (${crypto.randomUUID()}) returning id`;
  const [user] = await db<{ id: string }[]>`insert into users (tenant_id, telegram_user_id) values (${tenant.id}, ${crypto.randomUUID()}) returning id`;
  const [from] = await db<{ id: string }[]>`insert into locations (tenant_id, name, type) values (${tenant.id}, 'Warehouse', 'physical') returning id`;
  const [to] = await db<{ id: string }[]>`insert into locations (tenant_id, name, type) values (${tenant.id}, 'Store', 'physical') returning id`;
  const [item] = await db<{ id: string }[]>`insert into items (tenant_id, name, base_unit, default_reorder_threshold) values (${tenant.id}, 'Indomie', 'pcs', ${threshold}) returning id`;
  await db`insert into stock_levels (item_id, location_id, quantity) values (${item.id}, ${from.id}, ${quantity})`;
  await db`insert into telegram_chats (chat_id, tenant_id) values (${chatId}, ${tenant.id})`;
  return { tenantId: tenant.id, userId: user.id, chatId, itemId: item.id, fromId: from.id, toId: to.id };
}

function message(seed: Seed, toolName: WriteToolName, toolInput: Record<string, unknown>): IntentQueueMessage {
  return {
    id: crypto.randomUUID(),
    tenantId: seed.tenantId,
    chatId: seed.chatId,
    userId: seed.userId,
    toolName,
    toolInput: { tenantId: seed.tenantId, chatId: seed.chatId, userId: seed.userId, itemNameOrId: seed.itemId, ...toolInput },
    requiresConfirmation: toolName === 'adjust_stock',
    enqueuedAt: new Date().toISOString(),
  };
}

function sent(): Array<{ chat_id: string; text: string }> {
  return vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { chat_id: string; text: string });
}

async function effects(intent: IntentQueueMessage, output: WriteToolOutput): Promise<void> {
  await runPostWriteEffects(db, 'token', intent, output);
}

beforeEach(async () => {
  await db`truncate tenants cascade`;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await db.end(); });

describe('post-decrease low-stock effects', () => {
  it('alerts linked chats after a sale and excludes fallback and cross-tenant chats', async () => {
    const s = await seed();
    const other = await seed();
    await db`update telegram_chats set location_id = ${s.fromId} where chat_id = ${other.chatId}`;
    await db`insert into telegram_chats (chat_id, tenant_id, location_id) values ('-linked-1', ${s.tenantId}, ${s.fromId}), ('-linked-2', ${s.tenantId}, ${s.fromId})`;
    const intent = message(s, 'remove_stock', { locationId: s.fromId, quantity: 2, source: 'offline' });

    await effects(intent, await removeStock(db, intent.toolInput));

    expect(sent().map(({ chat_id }) => chat_id).sort()).toEqual(['-linked-1', '-linked-2']);
    expect(sent()[0].text).toContain('Indomie at Warehouse');
    expect(sent()[0].text).toContain('Remaining: 4 pcs');
    expect(sent()[0].text).toContain('Threshold: 5 pcs');
    expect(sent()[0].text).toContain('After: Sale');
  });

  it('alerts tenant-wide chats after a source transfer when no linked chat exists', async () => {
    const s = await seed();
    await db`insert into telegram_chats (chat_id, tenant_id) values ('-fallback', ${s.tenantId})`;
    const intent = message(s, 'transfer_stock', { fromLocationId: s.fromId, toLocationId: s.toId, quantity: 2 });

    await effects(intent, await transferStock(db, intent.toolInput));

    expect(sent().map(({ chat_id }) => chat_id).sort()).toEqual(['-fallback', s.chatId].sort());
    expect(sent()[0].text).toContain('After: Transfer');
  });

  it('alerts after a downward adjustment but not an upward adjustment', async () => {
    const s = await seed();
    const down = message(s, 'adjust_stock', { locationId: s.fromId, newQuantity: 4, reason: 'count' });
    await effects(down, await adjustStock(db, down.toolInput));
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toContain('After: Downward adjustment');

    const up = message(s, 'adjust_stock', { locationId: s.fromId, newQuantity: 7, reason: 'count' });
    await effects(up, await adjustStock(db, up.toolInput));
    expect(sent()).toHaveLength(1);
  });

  it('uses a location threshold override instead of the item default', async () => {
    const s = await seed(6, 10);
    await db`update stock_levels set reorder_threshold = 3 where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    const intent = message(s, 'remove_stock', { locationId: s.fromId, quantity: 2, source: 'offline' });

    await effects(intent, await removeStock(db, intent.toolInput));

    expect(sent()).toHaveLength(0);
  });

  it('does not alert after failed decreases', async () => {
    const s = await seed(2, 5);
    const sale = message(s, 'remove_stock', { locationId: s.fromId, quantity: 3, source: 'offline' });
    await effects(sale, await removeStock(db, sale.toolInput));
    const transfer = message(s, 'transfer_stock', { fromLocationId: s.fromId, toLocationId: s.toId, quantity: 3 });
    await effects(transfer, await transferStock(db, transfer.toolInput));

    expect(sent()).toHaveLength(0);
  });
});
