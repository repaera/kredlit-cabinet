import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { link, start } from '../../src/http/commands.ts';
import { decodeLocationCallback, encodeLocationCallback } from '../../src/lib/callback-data.ts';
import { classifyConfirmation } from '../../src/lib/confirm-classifier.ts';
import { rememberLocation, resolveIntentLocations } from '../../src/lib/location-resolution.ts';
import { addStock, adjustStock, checkStock, createItem, createLocation, exportStockReport, getItemHistory, listLowStock, removeStock, setReorderThreshold, transferStock } from '../../src/tools/execute.ts';
import { createTestDb } from '../support/database.ts';

const db = createTestDb();

async function fixture(quantity = 10) {
  const chatId = `-${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await start(db, chatId, '100', 'Ada', 'Brand X');
  const [actor] = await db<{ tenant_id: string; user_id: string }[]>`
    select tc.tenant_id, u.id user_id from telegram_chats tc join users u on u.tenant_id = tc.tenant_id where tc.chat_id = ${chatId}`;
  const context = { tenantId: actor.tenant_id, userId: actor.user_id, chatId };
  const warehouse = await createLocation(db, { ...context, name: 'Gudang A', type: 'physical' });
  const store = await createLocation(db, { ...context, name: 'Toko A', type: 'physical' });
  const website = await createLocation(db, { ...context, name: 'Website', type: 'own_website' });
  const shopee = await createLocation(db, { ...context, name: 'Shopee', type: 'marketplace' });
  const item = await createItem(db, { ...context, name: 'Indomie', baseUnit: 'pcs', defaultReorderThreshold: 5, units: [{ unitName: 'dus', conversionToBase: 40 }] });
  if (quantity) await addStock(db, { ...context, itemNameOrId: item.itemId, locationId: warehouse.locationId, quantity });
  return { ...context, itemId: item.itemId, warehouse: warehouse.locationId, store: store.locationId, website: website.locationId, shopee: shopee.locationId };
}

beforeEach(async () => { await db`truncate tenants cascade`; });
afterAll(async () => { await db.end(); });

describe('US-00 through US-12', () => {
  it('US-00 onboards a group once', async () => {
    const text = await start(db, '-1001', '1', 'Ada', 'Brand');
    expect(text).toContain('Welcome to Kredlit Cabinet');
    expect(await start(db, '-1001', '1', 'Ada', 'Brand')).toContain('already set up');
  });

  it('US-01 receives item-specific units', async () => {
    const s = await fixture(0);
    const result = await addStock(db, { ...s, itemNameOrId: s.itemId, locationId: s.warehouse, quantity: 5, unit: 'dus' });
    expect(result.newQuantity).toBe(200);
  });

  it('US-02 records an offline sale', async () => {
    const s = await fixture();
    expect(await removeStock(db, { ...s, itemNameOrId: s.itemId, locationId: s.warehouse, quantity: 3, source: 'offline' })).toMatchObject({ ok: true, newQuantity: 7 });
  });

  it('US-03 records an online order once', async () => {
    const s = await fixture();
    await addStock(db, { ...s, itemNameOrId: s.itemId, locationId: s.website, quantity: 3 });
    const input = { ...s, itemNameOrId: s.itemId, locationId: s.website, quantity: 2, source: 'online' as const, externalOrderId: '1032' };
    expect((await removeStock(db, input)).ok).toBe(true);
    expect(await removeStock(db, input)).toMatchObject({ error: 'duplicate_order' });
  });

  it('US-04 records a marketplace order', async () => {
    const s = await fixture();
    await addStock(db, { ...s, itemNameOrId: s.itemId, locationId: s.shopee, quantity: 2 });
    expect(await removeStock(db, { ...s, itemNameOrId: s.itemId, locationId: s.shopee, quantity: 1, source: 'marketplace', externalOrderId: 'SP-9981' })).toMatchObject({ ok: true, newQuantity: 1 });
  });

  it('US-05 transfers both ledger legs', async () => {
    const s = await fixture();
    expect(await transferStock(db, { ...s, itemNameOrId: s.itemId, fromLocationId: s.warehouse, toLocationId: s.shopee, quantity: 4 })).toMatchObject({ ok: true, fromNewQuantity: 6, toNewQuantity: 4 });
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int count from stock_transactions where type = 'transfer'`;
    expect(count).toBe(2);
  });

  it('US-06 checks every location', async () => {
    const s = await fixture();
    expect((await checkStock(db, { ...s, itemNameOrId: s.itemId })).levels).toHaveLength(4);
  });

  it('US-07 confirms before adjustment execution', async () => {
    const s = await fixture();
    expect(classifyConfirmation('ya')).toBe('CONFIRM');
    expect(await adjustStock(db, { ...s, itemNameOrId: s.itemId, locationId: s.warehouse, newQuantity: 8, reason: 'damaged' })).toMatchObject({ oldQuantity: 10, newQuantity: 8, delta: -2 });
  });

  it('US-08 lists an effective-threshold alert', async () => {
    const s = await fixture();
    await setReorderThreshold(db, { ...s, itemNameOrId: s.itemId, locationId: s.warehouse, threshold: 20 });
    expect((await listLowStock(db, { ...s })).items[0]).toMatchObject({ quantity: 10, threshold: 20 });
  });

  it('US-09 reads daily history', async () => {
    const s = await fixture();
    expect((await getItemHistory(db, { ...s, dateFrom: new Date().toISOString().slice(0, 10) })).transactions).toHaveLength(1);
  });

  it('US-10 resolves and remembers disambiguation', async () => {
    const s = await fixture();
    const callback = encodeLocationCallback('pending123', 'locationId', s.store.slice(0, 12));
    expect(decodeLocationCallback(callback)?.pendingActionId).toBe('pending123');
    await rememberLocation(db, s.chatId, s.userId, s.store);
    expect(await resolveIntentLocations(db, s, { toolName: 'remove_stock', toolInput: {} }, 'sell two')).toMatchObject({ status: 'resolved', toolInput: { locationId: s.store } });
  });

  it('US-11 links another group to one location', async () => {
    const s = await fixture();
    expect(await link(db, '-2002', '100', 'Toko A')).toContain('This group is now dedicated to Toko A.');
    const [chat] = await db<{ location_id: string }[]>`select location_id from telegram_chats where chat_id = '-2002'`;
    expect(chat.location_id).toBe(s.store);
  });

  it('US-12 exports an Excel document', async () => {
    const s = await fixture();
    const report = await exportStockReport(db, { ...s });
    expect(report).toMatchObject({ rowCount: 1, clamped: false });
    expect(report.fileName).toMatch(/^cabinet-export-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(report.fileBytes.byteLength).toBeGreaterThan(100);
  });
});
