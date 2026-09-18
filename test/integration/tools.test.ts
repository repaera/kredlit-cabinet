import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Db } from '../../src/db/client.ts';
import { start } from '../../src/http/commands.ts';
import { addStock, createItem, createLocation, exportStockReport, listLowStock, removeStock, transferStock } from '../../src/tools/execute.ts';
import { createTestDb } from '../support/database.ts';

const db = createTestDb();

interface Seed { tenantId: string; userId: string; chatId: string; itemId: string; fromId: string; toId: string }

async function seed(quantity = 5, threshold: number | null = null): Promise<Seed> {
  const chatId = String(-Math.floor(Math.random() * 1_000_000_000));
  const [tenant] = await db<{ id: string }[]>`insert into tenants (name) values ('Test') returning id`;
  const [user] = await db<{ id: string }[]>`insert into users (tenant_id, telegram_user_id) values (${tenant.id}, ${crypto.randomUUID()}) returning id`;
  await db`insert into telegram_chats (chat_id, tenant_id) values (${chatId}, ${tenant.id})`;
  const from = await createLocation(db, { tenantId: tenant.id, chatId, userId: user.id, name: 'Warehouse', type: 'physical' });
  const to = await createLocation(db, { tenantId: tenant.id, chatId, userId: user.id, name: 'Store', type: 'physical' });
  const item = await createItem(db, { tenantId: tenant.id, chatId, userId: user.id, name: 'Indomie', baseUnit: 'pcs', ...(threshold === null ? {} : { defaultReorderThreshold: threshold }), units: [{ unitName: 'dus', conversionToBase: 40 }] });
  if (quantity) await addStock(db, { tenantId: tenant.id, chatId, userId: user.id, itemNameOrId: item.itemId, locationId: from.locationId, quantity });
  return { tenantId: tenant.id, userId: user.id, chatId, itemId: item.itemId, fromId: from.locationId, toId: to.locationId };
}

beforeAll(async () => { await db`select 1`; });
beforeEach(async () => { await db`truncate tenants cascade`; });
afterAll(async () => { await db.end(); });

describe('database guarantees', () => {
  it('never oversells under concurrent removals', async () => {
    const s = await seed(3);
    const results = await Promise.all(Array.from({ length: 10 }, () => removeStock(db, { tenantId: s.tenantId, chatId: s.chatId, userId: s.userId, itemNameOrId: s.itemId, locationId: s.fromId, quantity: 1, source: 'offline' })));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    const [level] = await db<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    expect(level.quantity).toBe(0);
  });

  it('deduplicates external orders', async () => {
    const s = await seed(5);
    const input = { tenantId: s.tenantId, chatId: s.chatId, userId: s.userId, itemNameOrId: s.itemId, locationId: s.fromId, quantity: 2, source: 'online' as const, externalOrderId: crypto.randomUUID() };
    expect((await removeStock(db, input)).ok).toBe(true);
    expect(await removeStock(db, input)).toMatchObject({ ok: false, error: 'duplicate_order' });
    const [level] = await db<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${s.itemId} and location_id = ${s.fromId}`;
    expect(level.quantity).toBe(3);
  });

  it('scopes external order IDs by tenant', async () => {
    const first = await seed(5);
    const second = await seed(5);
    const externalOrderId = crypto.randomUUID();
    const remove = (s: Seed) => removeStock(db, { tenantId: s.tenantId, chatId: s.chatId, userId: s.userId, itemNameOrId: s.itemId, locationId: s.fromId, quantity: 2, source: 'online', externalOrderId });
    expect((await remove(first)).ok).toBe(true);
    expect((await remove(second)).ok).toBe(true);
    const rows = await db<{ tenant_id: string; quantity: number }[]>`select tenant_id, quantity from stock_transactions where source = 'online' and external_order_id = ${externalOrderId} order by tenant_id`;
    expect(rows).toEqual(expect.arrayContaining([{ tenant_id: first.tenantId, quantity: -2 }, { tenant_id: second.tenantId, quantity: -2 }]));
  });

  it('rolls back both transfer legs after a mid-transfer failure', async () => {
    const s = await seed(5);
    await expect(transferStock(db, { tenantId: s.tenantId, chatId: s.chatId, userId: s.userId, itemNameOrId: s.itemId, fromLocationId: s.fromId, toLocationId: s.toId, quantity: 2 }, true)).rejects.toThrow('forced transfer failure');
    const levels = await db<{ location_id: string; quantity: number }[]>`select location_id, quantity from stock_levels where item_id = ${s.itemId}`;
    expect(levels).toEqual([{ location_id: s.fromId, quantity: 5 }]);
  });

  it('reports low stock on the outgoing transfer location', async () => {
    const s = await seed(5, 4);
    await transferStock(db, { tenantId: s.tenantId, chatId: s.chatId, userId: s.userId, itemNameOrId: s.itemId, fromLocationId: s.fromId, toLocationId: s.toId, quantity: 2 });
    const result = await listLowStock(db, { tenantId: s.tenantId, chatId: s.chatId, userId: s.userId, locationId: s.fromId });
    expect(result.items).toMatchObject([{ itemId: s.itemId, quantity: 3, threshold: 4 }]);
  });

  it('makes onboarding idempotent by chat', async () => {
    const chatId = '-100123';
    await start(db, chatId, '42', 'Ada', 'Brand');
    await start(db, chatId, '42', 'Ada', 'Brand');
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int count from tenants`;
    expect(count).toBe(1);
  });

  it('exports only the requesting tenant', async () => {
    const first = await seed(1);
    await seed(1);
    const report = await exportStockReport(db, { tenantId: first.tenantId, chatId: first.chatId, userId: first.userId }, new Date());
    expect(report.rowCount).toBe(1);
    const rows = XLSX.utils.sheet_to_json(XLSX.read(report.fileBytes).Sheets.Transactions);
    expect(rows).toHaveLength(1);
  });

  it('allows only one pending action per chat and user', async () => {
    const s = await seed();
    await db`insert into pending_actions (id, tenant_id, chat_id, user_id, kind, intent, workflow_instance_id, expires_at) values ('pending-one', ${s.tenantId}, ${s.chatId}, ${s.userId}, 'confirmation', '{}', 'pending-one', now() + interval '10 minutes')`;
    await expect(db`insert into pending_actions (id, tenant_id, chat_id, user_id, kind, intent, workflow_instance_id, expires_at) values ('pending-two', ${s.tenantId}, ${s.chatId}, ${s.userId}, 'confirmation', '{}', 'pending-two', now() + interval '10 minutes')`).rejects.toMatchObject({ code: '23505' });
  });
});
