import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { encodeLocationCallback, decodeLocationCallback } from '../../src/lib/callback-data.ts';
import { classifyConfirmation } from '../../src/lib/confirm-classifier.ts';
import { clampExportRange } from '../../src/lib/date-range.ts';
import { requiresConfirmation } from '../../src/lib/requires-confirmation.ts';
import { resolveThreshold } from '../../src/lib/threshold.ts';
import { fromBase, toBase } from '../../src/lib/units.ts';
import { buildWorkbook } from '../../src/lib/xlsx-report.ts';
import { resolveProvider } from '../../src/llm/provider.ts';

describe('inventory primitives', () => {
  it('scopes conversion factors per item and round-trips', () => {
    expect(fromBase(toBase(5, 40), 40)).toBe(5);
    expect(fromBase(toBase(5, 24), 24)).toBe(5);
  });

  it('uses a location threshold before the item default', () => {
    expect(resolveThreshold(25, 10)).toBe(25);
    expect(resolveThreshold(null, 10)).toBe(10);
  });

  it('only confirms adjustments', () => {
    for (const tool of ['create_location', 'create_item', 'add_stock', 'remove_stock', 'transfer_stock', 'set_reorder_threshold']) expect(requiresConfirmation(tool)).toBe(false);
    expect(requiresConfirmation('adjust_stock')).toBe(true);
  });

  it('round-trips concurrent callback identifiers', () => {
    const values = ['abc123', 'def456', 'ghi789'].map((id, index) => encodeLocationCallback(id, 'toLocationId', `loc${index}`));
    expect(new Set(values).size).toBe(3);
    expect(values.map(decodeLocationCallback)).toEqual([
      { pendingActionId: 'abc123', field: 'toLocationId', locationShortId: 'loc0' },
      { pendingActionId: 'def456', field: 'toLocationId', locationShortId: 'loc1' },
      { pendingActionId: 'ghi789', field: 'toLocationId', locationShortId: 'loc2' },
    ]);
  });

  it.each([
    ['ya', 'CONFIRM'], ['iya', 'CONFIRM'], ['yes', 'CONFIRM'], ['ok', 'CONFIRM'], ['gas', 'CONFIRM'],
    ['batal', 'CANCEL'], ['cancel', 'CANCEL'], ['no', 'CANCEL'], ['gajadi', 'CANCEL'],
    ['sebentar', 'UNCLEAR'], ['nanti dulu', 'UNCLEAR'], ['?', 'UNCLEAR'],
  ] as const)('classifies %s as %s', (text, expected) => expect(classifyConfirmation(text)).toBe(expected));

  it('constructs both provider configurations without network calls', () => {
    const AI = {} as Ai;
    expect(resolveProvider({ AI, CABINET_MODEL: 'worker-kimi' })).toEqual({ kind: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6', binding: AI });
    expect(resolveProvider({ AI, CABINET_MODEL: 'worker-deepseek' })).toMatchObject({ kind: 'workers-ai', model: '@cf/deepseek-ai/deepseek-v4-pro-0813' });
    expect(resolveProvider({ AI, CABINET_MODEL: 'azure-deepseek', AZURE_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource', CF_AIG_TOKEN: 'token' })).toMatchObject({ kind: 'azure', model: 'DeepSeek-V4-Pro', url: expect.stringContaining('/DeepSeek-V4-Pro/chat/completions?api-version=2024-10-21'), headers: { 'cf-aig-authorization': 'Bearer token' } });
    expect(resolveProvider({ AI, CABINET_MODEL: 'azure-kimi', AZURE_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource', CF_AIG_TOKEN: 'token' })).toMatchObject({ kind: 'azure', model: 'Kimi-K2.6' });
    expect(resolveProvider({ AI, CABINET_MODEL: 'azure-kimi', AZURE_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/azure-openai/resource/DeepSeek-V4-Pro/chat/completions?api-version=2024-10-21', CF_AIG_TOKEN: 'token' })).toMatchObject({ url: expect.stringContaining('/Kimi-K2.6/chat/completions?api-version=2024-10-21') });
  });

  it('clamps exports to 90 days', () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(clampExportRange('2026-01-01', undefined, now).clamped).toBe(true);
    expect(clampExportRange('2026-09-01', undefined, now).clamped).toBe(false);
  });

  it('creates a parseable workbook with stable headers and rows', () => {
    const bytes = buildWorkbook([{ createdAt: '2026-09-18T00:00:00.000Z', item: 'Indomie', location: 'Store', type: 'in', quantity: 5, source: '', externalOrderId: '' }]);
    const workbook = XLSX.read(bytes);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Transactions, { header: 1 }) as unknown[][];
    expect(rows[0]).toEqual(['createdAt', 'item', 'location', 'type', 'quantity', 'source', 'externalOrderId']);
    expect(rows).toHaveLength(2);
  });
});
