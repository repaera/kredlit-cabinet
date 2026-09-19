import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/router.ts';
import { encodeLocationCallback } from '../../src/lib/callback-data.ts';
import type { ParsedIntent } from '../../src/llm/parse-intent.ts';
import { createTestDb, requireTestDatabaseUrl } from '../support/database.ts';

const db = createTestDb();
const testDatabaseUrl = requireTestDatabaseUrl();
const headers = { 'X-Telegram-Bot-Api-Secret-Token': 'secret', 'content-type': 'application/json' };

interface Harness {
  queued: Record<string, unknown>[];
  workflows: { created: Record<string, unknown>[]; events: Record<string, unknown>[] };
  outbound: Array<{ url: string; body: BodyInit | null | undefined }>;
  env: ReturnType<typeof environment>;
}

interface Fixture extends Harness {
  tenantId: string;
  userId: string;
  itemId: string;
  warehouseId: string;
  storeId: string;
  websiteId: string;
  shopeeId: string;
}

function environment(queued: Record<string, unknown>[], workflows: Harness['workflows']) {
  return {
    HYPERDRIVE: { connectionString: testDatabaseUrl },
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_RATE_LIMITER: { limit: async () => ({ success: true }) },
    INTENT_QUEUE: { send: async (message: Record<string, unknown>) => { queued.push(message); } },
    PENDING_ACTION_WORKFLOW: {
      create: async (input: Record<string, unknown>) => { workflows.created.push(input); },
      get: (id: string) => ({ sendEvent: async (input: Record<string, unknown>) => { workflows.events.push({ id, ...input }); } }),
    },
  } as never;
}

function messageUpdate(text: string, updateId = 1, chatId = -100, title = 'Brand X') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_789_689_600,
      chat: { id: chatId, type: 'supergroup', title },
      from: { id: 7, is_bot: false, first_name: 'Ada', username: 'ada' },
      text,
    },
  };
}

function callbackUpdate(data: string, updateId = 20) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 7, is_bot: false, first_name: 'Ada', username: 'ada' },
      message: {
        message_id: 19,
        date: 1_789_689_600,
        chat: { id: -100, type: 'supergroup', title: 'Brand X' },
      },
      chat_instance: 'chat-instance',
      data,
    },
  };
}

function harness(): Harness {
  const queued: Record<string, unknown>[] = [];
  const workflows = { created: [] as Record<string, unknown>[], events: [] as Record<string, unknown>[] };
  const outbound: Harness['outbound'] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    outbound.push({ url: String(url), body: init?.body });
    return new Response(null, { status: 200 });
  }));
  return { queued, workflows, outbound, env: environment(queued, workflows) };
}

async function request(update: unknown, state: Harness, intent?: ParsedIntent) {
  const app = intent ? createApp(async () => [intent]) : createApp();
  return app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update) }, state.env);
}

function jsonBodies(state: Harness, method = 'sendMessage'): Record<string, unknown>[] {
  return state.outbound
    .filter(({ url, body }) => url.endsWith(`/${method}`) && typeof body === 'string')
    .map(({ body }) => JSON.parse(body as string) as Record<string, unknown>);
}

async function fixture(): Promise<Fixture> {
  const state = harness();
  expect((await request(messageUpdate('/start@KredlitCabinetBot'), state)).status).toBe(200);
  const [actor] = await db<{ tenant_id: string; user_id: string }[]>`
    select tc.tenant_id, u.id user_id from telegram_chats tc join users u on u.tenant_id = tc.tenant_id
    where tc.chat_id = '-100' and u.telegram_user_id = '7'`;
  const locations = await db<{ id: string; name: string }[]>`
    insert into locations (tenant_id, name, type) values
      (${actor.tenant_id}, 'Gudang A', 'physical'),
      (${actor.tenant_id}, 'Toko A', 'physical'),
      (${actor.tenant_id}, 'Website', 'own_website'),
      (${actor.tenant_id}, 'Shopee', 'marketplace') returning id, name`;
  const [item] = await db<{ id: string }[]>`
    insert into items (tenant_id, name, base_unit, default_reorder_threshold)
    values (${actor.tenant_id}, 'Indomie', 'pcs', 5) returning id`;
  await db`insert into item_units (item_id, unit_name, conversion_to_base) values (${item.id}, 'dus', 40)`;
  const locationId = (name: string) => locations.find((location) => location.name === name)!.id;
  const warehouseId = locationId('Gudang A');
  const storeId = locationId('Toko A');
  const websiteId = locationId('Website');
  const shopeeId = locationId('Shopee');
  await db`insert into stock_levels (item_id, location_id, quantity) values
    (${item.id}, ${warehouseId}, 10), (${item.id}, ${storeId}, 6),
    (${item.id}, ${websiteId}, 3), (${item.id}, ${shopeeId}, 2)`;
  await db`insert into stock_transactions (tenant_id, item_id, location_id, type, quantity, created_by)
    values (${actor.tenant_id}, ${item.id}, ${warehouseId}, 'in', 10, ${actor.user_id})`;
  state.outbound.length = 0;
  return { ...state, tenantId: actor.tenant_id, userId: actor.user_id, itemId: item.id, warehouseId, storeId, websiteId, shopeeId };
}

function expectQueued(state: Fixture, toolName: string, toolInput: Record<string, unknown>, requiresConfirmation = false) {
  expect(state.queued).toHaveLength(1);
  expect(state.queued[0]).toMatchObject({
    id: expect.any(String),
    tenantId: state.tenantId,
    chatId: '-100',
    userId: state.userId,
    toolName,
    toolInput: { tenantId: state.tenantId, chatId: '-100', userId: state.userId, ...toolInput },
    requiresConfirmation,
    enqueuedAt: expect.any(String),
  });
}

beforeEach(async () => {
  await db`truncate tenants cascade`;
  vi.unstubAllGlobals();
});
afterAll(async () => { await db.end(); });

describe('TelegramUpdate stories US-00 through US-12', () => {
  it('US-00 onboards a group through a complete Telegram message update', async () => {
    const state = harness();
    expect((await request(messageUpdate('/start@KredlitCabinetBot'), state)).status).toBe(200);

    const [counts] = await db<{ tenants: number; chats: number; users: number }[]>`
      select (select count(*)::int from tenants) tenants,
        (select count(*)::int from telegram_chats) chats,
        (select count(*)::int from users) users`;
    expect(counts).toEqual({ tenants: 1, chats: 1, users: 1 });
    expect(jsonBodies(state)).toEqual([expect.objectContaining({ chat_id: '-100', text: expect.stringContaining('Welcome to Kredlit Cabinet') })]);
  });

  it('US-01 queues receipt quantity and item-specific unit without mutating stock', async () => {
    const state = await fixture();
    const response = await request(messageUpdate('terima 5 dus Indomie di Gudang A', 2), state, {
      toolName: 'add_stock', toolInput: { itemNameOrId: 'Indomie', locationId: state.warehouseId, quantity: 5, unit: 'dus' },
    });

    expect(response.status).toBe(202);
    expectQueued(state, 'add_stock', { itemNameOrId: 'Indomie', locationId: state.warehouseId, quantity: 5, unit: 'dus' });
    const [level] = await db<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${state.itemId} and location_id = ${state.warehouseId}`;
    expect(level.quantity).toBe(10);
  });

  it('US-02 queues an offline sale with its resolved location', async () => {
    const state = await fixture();
    await request(messageUpdate('jual 3 pcs Indomie di Toko A', 2), state, {
      toolName: 'remove_stock', toolInput: { itemNameOrId: 'Indomie', locationId: state.storeId, quantity: 3, unit: 'pcs', source: 'offline' },
    });

    expectQueued(state, 'remove_stock', { itemNameOrId: 'Indomie', locationId: state.storeId, quantity: 3, unit: 'pcs', source: 'offline' });
  });

  it('US-03 preserves an own-website order ID in the Queue envelope', async () => {
    const state = await fixture();
    await request(messageUpdate('order #1032, 2 pcs Indomie di Website', 2), state, {
      toolName: 'remove_stock', toolInput: { itemNameOrId: 'Indomie', locationId: state.websiteId, quantity: 2, source: 'online', externalOrderId: '1032' },
    });

    expectQueued(state, 'remove_stock', { itemNameOrId: 'Indomie', locationId: state.websiteId, quantity: 2, source: 'online', externalOrderId: '1032' });
  });

  it('US-04 preserves a marketplace order ID in the Queue envelope', async () => {
    const state = await fixture();
    await request(messageUpdate('laku 1 pcs Indomie di Shopee, order SP-9981', 2), state, {
      toolName: 'remove_stock', toolInput: { itemNameOrId: 'Indomie', locationId: state.shopeeId, quantity: 1, source: 'marketplace', externalOrderId: 'SP-9981' },
    });

    expectQueued(state, 'remove_stock', { itemNameOrId: 'Indomie', locationId: state.shopeeId, quantity: 1, source: 'marketplace', externalOrderId: 'SP-9981' });
  });

  it('US-05 queues distinct tenant-owned transfer endpoints and does not write ledger legs', async () => {
    const state = await fixture();
    await request(messageUpdate('alokasikan 4 pcs Indomie dari Gudang A ke Shopee', 2), state, {
      toolName: 'transfer_stock', toolInput: { itemNameOrId: 'Indomie', fromLocationId: state.warehouseId, toLocationId: state.shopeeId, quantity: 4 },
    });

    expectQueued(state, 'transfer_stock', { itemNameOrId: 'Indomie', fromLocationId: state.warehouseId, toLocationId: state.shopeeId, quantity: 4 });
    const [{ count }] = await db<{ count: number }[]>`select count(*)::int count from stock_transactions where type = 'transfer'`;
    expect(count).toBe(0);
  });

  it('US-06 reads stock synchronously and sends formatted location quantities without IDs', async () => {
    const state = await fixture();
    await request(messageUpdate('stok Indomie di mana saja?', 2), state, {
      toolName: 'check_stock', toolInput: { itemNameOrId: 'Indomie' },
    });

    expect(state.queued).toHaveLength(0);
    const [payload] = jsonBodies(state);
    expect(payload).toMatchObject({ chat_id: '-100', text: expect.stringContaining('📦 Indomie stock') });
    expect(payload.text).toEqual(expect.stringContaining('• Gudang A: 10 pcs'));
    expect(payload.text).toEqual(expect.stringContaining('• Shopee: 2 pcs'));
    expect(payload.text).not.toEqual(expect.stringContaining(state.itemId));
    expect(payload.text).not.toEqual(expect.stringContaining(state.warehouseId));
  });

  it('US-07 queues a destructive adjustment and routes confirm and cancel replies to Workflow', async () => {
    const state = await fixture();
    await request(messageUpdate('koreksi stok Indomie di Toko A jadi 4 pcs karena rusak', 2), state, {
      toolName: 'adjust_stock', toolInput: { itemNameOrId: 'Indomie', locationId: state.storeId, newQuantity: 4, reason: 'damaged' },
    });
    expectQueued(state, 'adjust_stock', { itemNameOrId: 'Indomie', locationId: state.storeId, newQuantity: 4, reason: 'damaged' }, true);

    await db`insert into pending_actions (id, tenant_id, chat_id, user_id, kind, intent, workflow_instance_id, expires_at)
      values ('confirm123', ${state.tenantId}, '-100', ${state.userId}, 'confirmation', ${db.json(state.queued[0] as never)}, 'confirm-workflow', now() + interval '10 minutes')`;
    await request(messageUpdate('ya', 3), state);
    await request(messageUpdate('batal', 4), state);
    expect(state.workflows.events).toEqual([
      { id: 'confirm-workflow', type: 'user-response', payload: { kind: 'confirmation', confirmed: true } },
      { id: 'confirm-workflow', type: 'user-response', payload: { kind: 'confirmation', confirmed: false } },
    ]);
  });

  it('US-08 reads effective low-stock results and sends a structured alert-shaped message', async () => {
    const state = await fixture();
    await request(messageUpdate('apa yang stoknya rendah?', 2), state, { toolName: 'list_low_stock', toolInput: {} });

    expect(state.queued).toHaveLength(0);
    const [payload] = jsonBodies(state);
    expect(payload).toMatchObject({ chat_id: '-100', text: expect.stringContaining('⚠️ Low stock') });
    expect(payload.text).toEqual(expect.stringContaining('Indomie at Website: 3 (threshold 5)'));
    expect(payload.text).toEqual(expect.stringContaining('Indomie at Shopee: 2 (threshold 5)'));
  });

  it('US-09 reads daily history synchronously and returns signed transaction details', async () => {
    const state = await fixture();
    const today = new Date().toISOString().slice(0, 10);
    await request(messageUpdate('riwayat hari ini', 2), state, {
      toolName: 'get_item_history', toolInput: { itemNameOrId: 'Indomie', dateFrom: today, dateTo: today },
    });

    const [payload] = jsonBodies(state);
    expect(payload).toMatchObject({ chat_id: '-100', text: expect.stringContaining('🧾 Inventory history') });
    expect(payload.text).toEqual(expect.stringContaining('· In · +10'));
    expect(payload.text).not.toEqual(expect.stringContaining(state.itemId));
  });

  it('US-10 parks an unresolved location and forwards an owned callback to Workflow', async () => {
    const state = await fixture();
    await request(messageUpdate('jual 2 pcs Indomie', 2), state, {
      toolName: 'remove_stock', toolInput: { itemNameOrId: 'Indomie', quantity: 2, source: 'offline' },
    });

    expect(state.queued).toHaveLength(0);
    const [pending] = await db<{ id: string; status: string; missing_location_field: string; intent: Record<string, unknown> }[]>`
      select id, status, missing_location_field, intent from pending_actions`;
    expect(pending).toMatchObject({ status: 'pending', missing_location_field: 'locationId', intent: { toolName: 'remove_stock' } });
    expect(state.workflows.created[0]).toMatchObject({
      id: pending.id,
      params: { pendingActionId: pending.id, tenantId: state.tenantId, kind: 'location_disambiguation', missingLocationField: 'locationId' },
    });

    const callback = encodeLocationCallback(pending.id, 'locationId', state.storeId.slice(0, 12));
    expect((await request(callbackUpdate(callback), state)).status).toBe(200);
    expect(state.workflows.events).toContainEqual({
      id: pending.id,
      type: 'user-response',
      payload: { kind: 'location_disambiguation', field: 'locationId', locationId: state.storeId },
    });
    expect(jsonBodies(state, 'answerCallbackQuery')).toContainEqual({ callback_query_id: 'callback-20' });
    expect(jsonBodies(state, 'editMessageReplyMarkup')).toContainEqual({ chat_id: '-100', message_id: 19, reply_markup: { inline_keyboard: [] } });
  });

  it('US-11 links a second group and returns a structured confirmation', async () => {
    const state = await fixture();
    expect((await request(messageUpdate('/link Toko A', 2, -200, 'Toko A team'), state)).status).toBe(200);

    const [chat] = await db<{ tenant_id: string; location_id: string }[]>`select tenant_id, location_id from telegram_chats where chat_id = '-200'`;
    expect(chat).toEqual({ tenant_id: state.tenantId, location_id: state.storeId });
    expect(jsonBodies(state)).toContainEqual({ chat_id: '-200', text: '📍 Group linked\n\nThis group is now dedicated to Toko A.' });
  });

  it('US-12 exports an isolated XLSX document with structured multipart metadata', async () => {
    const state = await fixture();
    await request(messageUpdate('export laporan stok', 2), state, { toolName: 'export_stock_report', toolInput: { itemNameOrId: 'Indomie' } });

    expect(state.queued).toHaveLength(0);
    const sent = state.outbound.find(({ url }) => url.endsWith('/sendDocument'));
    expect(sent?.body).toBeInstanceOf(FormData);
    const form = sent!.body as FormData;
    const document = form.get('document');
    expect(form.get('chat_id')).toBe('-100');
    expect(form.get('caption')).toEqual(expect.stringMatching(/^📊 Stock report\n1 transactions\n/));
    expect(document).toBeInstanceOf(File);
    expect(document).toMatchObject({ name: expect.stringMatching(/\.xlsx$/), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect((document as File).size).toBeGreaterThan(100);
  });
});
