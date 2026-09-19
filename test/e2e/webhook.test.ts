import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/http/router.ts';
import { createTestDb, requireTestDatabaseUrl } from '../support/database.ts';

const db = createTestDb();
const testDatabaseUrl = requireTestDatabaseUrl();

function environment(sent: unknown[], workflows: { created: unknown[]; events: unknown[] } = { created: [], events: [] }) {
  return {
    HYPERDRIVE: { connectionString: testDatabaseUrl },
    TELEGRAM_WEBHOOK_SECRET: 'secret',
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_RATE_LIMITER: { limit: async () => ({ success: true }) },
    INTENT_QUEUE: { send: async (message: unknown) => { sent.push(message); } },
    PENDING_ACTION_WORKFLOW: {
      create: async (input: unknown) => { workflows.created.push(input); },
      get: () => ({ sendEvent: async (input: unknown) => { workflows.events.push(input); } }),
    },
  } as never;
}

function update(text: string, id = 1) {
  return { update_id: id, message: { message_id: id, chat: { id: -100, type: 'group', title: 'Brand X' }, from: { id: 7, first_name: 'Ada' }, text } };
}

const headers = { 'X-Telegram-Bot-Api-Secret-Token': 'secret', 'content-type': 'application/json' };

async function fixture() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  const app = createApp();
  await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('/start')) }, environment([]));
  const [actor] = await db<{ tenant_id: string; user_id: string }[]>`select tc.tenant_id, u.id user_id from telegram_chats tc join users u on u.tenant_id = tc.tenant_id where tc.chat_id = '-100'`;
  const locations = await db<{ id: string; name: string }[]>`insert into locations (tenant_id, name, type) values (${actor.tenant_id}, 'Store', 'physical'), (${actor.tenant_id}, 'Warehouse', 'physical') returning id, name`;
  return { ...actor, store: locations.find((location) => location.name === 'Store')!.id, warehouse: locations.find((location) => location.name === 'Warehouse')!.id };
}

beforeEach(async () => { await db`truncate tenants cascade`; vi.restoreAllMocks(); });
afterAll(async () => { await db.end(); });

describe('Telegram webhook', () => {
  it('validates the secret and sends the onboarding reply', async () => {
    const outbound: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { outbound.push(String(init?.body)); return new Response('{}'); }));
    const app = createApp();
    const denied = await app.request('/telegram/webhook', { method: 'POST', body: JSON.stringify(update('/start@KredlitCabinetBot')) }, environment([]));
    expect(denied.status).toBe(401);
    const response = await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('/start@KredlitCabinetBot')) }, environment([]));
    expect(response.status).toBe(200);
    expect(JSON.parse(outbound[0])).toMatchObject({ chat_id: '-100', text: expect.stringContaining('Welcome to Kredlit Cabinet') });
  });

  it('queues a mocked write intent instead of executing it in the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const setup = createApp();
    await setup.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('/start')) }, environment([]));
    const [actor] = await db<{ tenant_id: string; user_id: string }[]>`select tc.tenant_id, u.id user_id from telegram_chats tc join users u on u.tenant_id = tc.tenant_id where tc.chat_id = '-100'`;
    const [location] = await db<{ id: string }[]>`insert into locations (tenant_id, name, type) values (${actor.tenant_id}, 'Store', 'physical') returning id`;
    await db`insert into items (tenant_id, name) values (${actor.tenant_id}, 'Soap')`;
    const sent: unknown[] = [];
    const app = createApp(async () => [{ toolName: 'add_stock', toolInput: { itemNameOrId: 'Soap', locationId: location.id, quantity: 2 } }]);
    const response = await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('received two Soap', 2)) }, environment(sent));
    expect(response.status).toBe(202);
    expect(sent).toMatchObject([{ toolName: 'add_stock', requiresConfirmation: false, tenantId: actor.tenant_id }]);
    const levels = await db`select * from stock_levels`;
    expect(levels).toHaveLength(0);
  });

  it('uses a tenant-validated linked chat before an explicit model location', async () => {
    const s = await fixture();
    await db`update telegram_chats set location_id = ${s.store} where chat_id = '-100'`;
    const sent: Record<string, unknown>[] = [];
    const app = createApp(async () => [{ toolName: 'add_stock', toolInput: { itemNameOrId: 'Soap', locationId: s.warehouse, quantity: 2 } }]);
    await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('receive Soap at Warehouse', 2)) }, environment(sent));
    expect(sent[0].toolInput).toMatchObject({ locationId: s.store });
  });

  it('uses an explicit location and then a remembered location in a tenant-wide chat', async () => {
    const s = await fixture();
    const sent: Record<string, unknown>[] = [];
    const explicit = createApp(async () => [{ toolName: 'add_stock', toolInput: { itemNameOrId: 'Soap', locationId: s.warehouse, quantity: 1 } }]);
    await explicit.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('receive at Warehouse', 2)) }, environment(sent));
    expect(sent[0].toolInput).toMatchObject({ locationId: s.warehouse });
    await db`insert into session_context (chat_id, user_id, last_location_id) values ('-100', ${s.user_id}, ${s.store})`;
    const remembered = createApp(async () => [{ toolName: 'remove_stock', toolInput: { itemNameOrId: 'Soap', quantity: 1, source: 'offline' } }]);
    await remembered.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('sell Soap', 3)) }, environment(sent));
    expect(sent[1].toolInput).toMatchObject({ locationId: s.store });
  });

  it('uses the explicit message name over a different tenant-valid model ID', async () => {
    const s = await fixture();
    const sent: Record<string, unknown>[] = [];
    const app = createApp(async () => [{ toolName: 'add_stock', toolInput: { itemNameOrId: 'Soap', locationId: s.store, quantity: 1 } }]);
    await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('receive Soap at Warehouse', 2)) }, environment(sent));
    expect(sent[0].toolInput).toMatchObject({ locationId: s.warehouse });
  });

  it('parks cross-tenant and ambiguous model locations without queueing', async () => {
    const s = await fixture();
    const [otherTenant] = await db<{ id: string }[]>`insert into tenants (name) values ('Other') returning id`;
    const [foreign] = await db<{ id: string }[]>`insert into locations (tenant_id, name, type) values (${otherTenant.id}, 'Foreign', 'physical') returning id`;
    await db`insert into locations (tenant_id, name, type) values (${s.tenant_id}, 'store', 'physical')`;
    const sent: unknown[] = [];
    const workflows = { created: [] as unknown[], events: [] as unknown[] };
    const foreignApp = createApp(async () => [{ toolName: 'add_stock', toolInput: { itemNameOrId: 'Soap', locationId: foreign.id, quantity: 1 } }]);
    await foreignApp.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('receive Soap', 2)) }, environment(sent, workflows));
    expect(sent).toHaveLength(0);
    expect(workflows.created[0]).toMatchObject({ params: { missingLocationField: 'locationId' } });
    await db`update pending_actions set status = 'cancelled' where status = 'pending'`;
    const ambiguousApp = createApp(async () => [{ toolName: 'add_stock', toolInput: { itemNameOrId: 'Soap', quantity: 1 } }]);
    await ambiguousApp.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('receive Soap at STORE', 3)) }, environment(sent, workflows));
    expect(workflows.created[1]).toMatchObject({ params: { missingLocationField: 'locationId' } });
  });

  it('resolves transfer slots independently and rejects the same location', async () => {
    const s = await fixture();
    await db`update telegram_chats set location_id = ${s.store} where chat_id = '-100'`;
    const sent: Record<string, unknown>[] = [];
    const app = createApp(async () => [{ toolName: 'transfer_stock', toolInput: { itemNameOrId: 'Soap', toLocationId: s.warehouse, quantity: 1 } }]);
    await app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('transfer Soap to Warehouse', 2)) }, environment(sent));
    expect(sent[0].toolInput).toMatchObject({ fromLocationId: s.store, toLocationId: s.warehouse });
    const same = createApp(async () => [{ toolName: 'transfer_stock', toolInput: { itemNameOrId: 'Soap', fromLocationId: s.store, toLocationId: s.store, quantity: 1 } }]);
    await same.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update('bad transfer', 3)) }, environment(sent));
    expect(sent).toHaveLength(1);
  });

  it('answers stale callbacks, clears their markup, and never resumes them', async () => {
    await fixture();
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => { requests.push(String(url)); return new Response('{}'); }));
    const workflows = { created: [] as unknown[], events: [] as unknown[] };
    const callbackUpdate = { update_id: 2, callback_query: { id: 'callback-1', from: { id: 7, first_name: 'Ada' }, message: { message_id: 9, chat: { id: -100, type: 'group' } }, data: 'da:missing:l:123456789012' } };
    const response = await createApp().request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(callbackUpdate) }, environment([], workflows));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, error: 'expired_or_unknown_callback' });
    expect(requests.some((url) => url.endsWith('/answerCallbackQuery'))).toBe(true);
    expect(requests.some((url) => url.endsWith('/editMessageReplyMarkup'))).toBe(true);
    expect(workflows.events).toHaveLength(0);
  });
});
