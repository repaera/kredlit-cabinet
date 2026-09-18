import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: undefined as unknown,
  execute: vi.fn(),
  sendMessage: vi.fn(),
  resolveLocations: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
vi.mock('../../src/db/client.ts', () => ({ createDb: () => mocks.db }));
vi.mock('../../src/tools/execute-intent.ts', () => ({ executeQueuedIntent: mocks.execute }));
vi.mock('../../src/telegram/client.ts', () => ({ sendMessage: mocks.sendMessage }));
vi.mock('../../src/lib/location-resolution.ts', () => ({ resolveIntentLocations: mocks.resolveLocations }));
vi.mock('../../src/lib/post-write-effects.ts', () => ({ runPostWriteEffects: vi.fn() }));
vi.mock('../../src/telegram/messages.ts', () => ({
  formatAdjustmentPrompt: () => 'prompt',
  formatToolResult: () => 'result',
  loadToolPresentation: vi.fn().mockResolvedValue({}),
}));

import { PendingActionWorkflow } from '../../src/workflows/pending-action-workflow.ts';
import type { IntentQueueMessage, PendingActionWorkflowParams } from '../../src/types/flow.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const chatId = '-1001';

interface PendingState {
  id: string;
  tenantId: string;
  chatId: string;
  userId: string;
  kind: 'confirmation' | 'location_disambiguation';
  field: 'locationId' | 'fromLocationId' | 'toLocationId' | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'resolved';
  expired?: boolean;
}

function fakeDb(state: PendingState) {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ');
    if (query.includes('select expires_at <= now() expired')) {
      const owned = values[0] === state.id && values[1] === state.tenantId && values[2] === state.chatId && values[3] === state.userId;
      return owned && state.status === 'pending' ? [{ expired: state.expired ?? false }] : [];
    }
    if (query.includes('select id from pending_actions')) {
      const owned = values[0] === state.id && values[1] === state.tenantId && values[2] === state.chatId && values[3] === state.userId;
      const kind = query.includes("kind = 'confirmation'") ? 'confirmation' : 'location_disambiguation';
      const fieldMatches = !query.includes('missing_location_field = ?') || values[4] === state.field;
      return owned && state.kind === kind && state.status === 'pending' && fieldMatches ? [{ id: state.id }] : [];
    }
    if (query.includes('update pending_actions set status =')) {
      const owned = values[0] === state.id && values[1] === state.tenantId && values[2] === state.chatId && values[3] === state.userId;
      const kind = query.includes("kind = 'confirmation'") ? 'confirmation' : query.includes("kind = 'location_disambiguation'") ? 'location_disambiguation' : values[4];
      const fieldIndex = query.includes("kind = 'location_disambiguation'") ? 4 : -1;
      const fieldMatches = !query.includes('missing_location_field = ?') || values[fieldIndex] === state.field;
      if (!owned || kind !== state.kind || state.status !== 'pending' || !fieldMatches) return [];
      state.status = query.includes("status = 'confirmed'") ? 'confirmed'
        : query.includes("status = 'cancelled'") ? 'cancelled'
          : query.includes("status = 'resolved'") ? 'resolved' : 'expired';
      return [{ id: state.id }];
    }
    if (query.includes('select id, name from locations')) return [];
    throw new Error(`Unexpected SQL in workflow test: ${query}`);
  };
  return Object.assign(sql, {
    begin: async <T>(run: (tx: typeof sql) => Promise<T>) => run(sql),
    end: vi.fn(),
    json: (value: unknown) => value,
  });
}

function adjustmentIntent(overrides: Partial<IntentQueueMessage> = {}): IntentQueueMessage {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenantId,
    chatId,
    userId,
    toolName: 'adjust_stock',
    toolInput: { tenantId, chatId, userId, itemNameOrId: itemId, locationId, newQuantity: 4, reason: 'count' },
    requiresConfirmation: true,
    enqueuedAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

function params(intent = adjustmentIntent()): PendingActionWorkflowParams {
  return { pendingActionId: 'pending-1', tenantId, chatId, userId, kind: 'confirmation', intent, timeoutMinutes: 10 };
}

function workflow(state: PendingState) {
  mocks.db = fakeDb(state);
  const instance = Object.create(PendingActionWorkflow.prototype) as PendingActionWorkflow & { env: unknown };
  instance.env = {
    HYPERDRIVE: { connectionString: 'mock' },
    TELEGRAM_BOT_TOKEN: 'token',
    INTENT_QUEUE: { send: vi.fn() },
  } as never;
  return instance;
}

function step(response: unknown, timeout = false) {
  return {
    do: async (_name: string, run: () => Promise<unknown>) => run(),
    waitForEvent: async () => {
      if (timeout) throw new Error('timeout');
      return { payload: response };
    },
  };
}

function pending(kind: PendingState['kind'] = 'confirmation'): PendingState {
  return { id: 'pending-1', tenantId, chatId, userId, kind, field: kind === 'location_disambiguation' ? 'locationId' : null, status: 'pending' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ transactionId: 'tx', oldQuantity: 10, newQuantity: 4, delta: -6 });
});

describe('pending action workflow boundaries', () => {
  it('rejects invalid params before side effects', async () => {
    const state = pending();
    await expect(workflow(state).run({ payload: { ...params(), tenantId: 'bad' } } as never, step({ kind: 'confirmation', confirmed: true }) as never)).rejects.toThrow();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid and wrong-kind events instead of treating them as timeouts', async () => {
    const invalidState = pending();
    await expect(workflow(invalidState).run({ payload: params() } as never, step({ kind: 'confirmation', confirmed: 'yes' }) as never)).rejects.toThrow();
    expect(invalidState.status).toBe('pending');

    const wrongKindState = pending();
    await expect(workflow(wrongKindState).run({ payload: params() } as never, step({ kind: 'location_disambiguation', field: 'locationId', locationId }) as never)).rejects.toThrow('wrong event kind');
    expect(wrongKindState.status).toBe('pending');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects mismatched parked-intent ownership and confirmation kind before side effects', async () => {
    const ownerState = pending();
    await expect(workflow(ownerState).run({ payload: params(adjustmentIntent({ tenantId: crypto.randomUUID() })) } as never, step({}) as never)).rejects.toThrow('ownership');

    const kindState = pending();
    const wrongKind = adjustmentIntent({ toolName: 'add_stock', requiresConfirmation: false });
    await expect(workflow(kindState).run({ payload: params(wrongKind) } as never, step({}) as never)).rejects.toThrow('wrong parked intent kind');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid parked tool input before side effects', async () => {
    const state = pending();
    const invalid = adjustmentIntent({ toolInput: { tenantId, chatId, userId } });
    await expect(workflow(state).run({ payload: params(invalid) } as never, step({}) as never)).rejects.toThrow();
    expect(state.status).toBe('pending');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects a wrong location field without changing state', async () => {
    const state = pending('location_disambiguation');
    const locationParams: PendingActionWorkflowParams = { ...params(), kind: 'location_disambiguation', missingLocationField: 'locationId' };
    await expect(workflow(state).run({ payload: locationParams } as never, step({ kind: 'location_disambiguation', field: 'toLocationId', locationId }) as never)).rejects.toThrow('wrong field');
    expect(state.status).toBe('pending');
    expect(mocks.resolveLocations).not.toHaveBeenCalled();
  });

  it('confirms once and fails closed on a duplicate event or state', async () => {
    const state = pending();
    const instance = workflow(state);
    const event = step({ kind: 'confirmation', confirmed: true });
    await instance.run({ payload: params() } as never, event as never);
    await expect(instance.run({ payload: params() } as never, event as never)).rejects.toThrow('not active');
    expect(state.status).toBe('confirmed');
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('cancels without execution and leaves duplicate state unchanged', async () => {
    const state = pending();
    const instance = workflow(state);
    const event = step({ kind: 'confirmation', confirmed: false });
    await instance.run({ payload: params() } as never, event as never);
    await expect(instance.run({ payload: params() } as never, event as never)).rejects.toThrow('not active');
    expect(state.status).toBe('cancelled');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('expires without execution and leaves duplicate state unchanged', async () => {
    const state = pending();
    const instance = workflow(state);
    const timeout = step(undefined, true);
    await instance.run({ payload: params() } as never, timeout as never);
    await expect(instance.run({ payload: params() } as never, timeout as never)).rejects.toThrow('not active');
    expect(state.status).toBe('expired');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('expires immediately when the action expired before Workflow startup', async () => {
    const state = { ...pending(), expired: true };
    await workflow(state).run({ payload: params() } as never, step({ kind: 'confirmation', confirmed: true }) as never);
    expect(state.status).toBe('expired');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects a pending row owned by another user or chat', async () => {
    const state = { ...pending(), userId: crypto.randomUUID(), chatId: '-other' };
    await expect(workflow(state).run({ payload: params() } as never, step({ kind: 'confirmation', confirmed: true }) as never)).rejects.toThrow('not active or owned');
    expect(state.status).toBe('pending');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('retries a failed result notification without repeating confirmation', async () => {
    const state = pending();
    mocks.sendMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Telegram unavailable')).mockResolvedValue(undefined);
    const retryingStep = {
      do: async (name: string, run: () => Promise<unknown>) => {
        try { return await run(); } catch (error) {
          if (name !== 'send result') throw error;
          return run();
        }
      },
      waitForEvent: async () => ({ payload: { kind: 'confirmation', confirmed: true } }),
    };
    await workflow(state).run({ payload: params() } as never, retryingStep as never);
    expect(state.status).toBe('confirmed');
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);
  });
});
