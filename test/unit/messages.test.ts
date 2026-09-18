import { describe, expect, it } from 'vitest';
import { formatAdjustmentPrompt, formatLowStockAlert, formatReportCaption, formatToolResult } from '../../src/telegram/messages.ts';

const context = { tenantId: 'tenant', chatId: 'chat', userId: 'user' };

describe('Telegram result messages', () => {
  it('formats stock levels without exposing IDs', () => {
    const text = formatToolResult('check_stock', {}, {
      item: { id: 'item-id', name: 'Indomie', baseUnit: 'pcs' },
      levels: [{ locationId: 'location-id', locationName: 'Toko A', quantity: 187, displayUnit: { unitName: 'dus', quantity: 4.675 } }],
    });
    expect(text).toBe('📦 Indomie stock\n\n• Toko A: 187 pcs (4.675 dus)');
    expect(text).not.toContain('item-id');
    expect(text).not.toContain('location-id');
  });

  it('formats successful and rejected removals', () => {
    const input = { ...context, itemNameOrId: 'Indomie', locationId: 'location', quantity: 3, unit: 'pcs', source: 'offline' };
    expect(formatToolResult('remove_stock', input, { ok: true, transactionId: 'transaction', newQuantity: 187 }, { itemName: 'Indomie', locationName: 'Toko A', baseUnit: 'pcs' })).toContain('Remaining: 187 pcs');
    expect(formatToolResult('remove_stock', input, { ok: false, error: 'insufficient_stock', availableQuantity: 2 }, { itemName: 'Indomie', baseUnit: 'pcs' })).toContain('Available: 2 pcs');
  });

  it('formats detailed adjustment confirmation and result copy', () => {
    const input = { ...context, itemNameOrId: 'Indomie', locationId: 'location', newQuantity: 190, unit: 'pcs', reason: 'damaged' };
    expect(formatAdjustmentPrompt(input, { itemName: 'Indomie', locationName: 'Toko A', baseUnit: 'pcs' }, 10)).toContain('Set stock to: 190 pcs');
    expect(formatToolResult('adjust_stock', input, { transactionId: 'transaction', oldQuantity: 200, newQuantity: 190, delta: -10 }, { itemName: 'Indomie', locationName: 'Toko A', baseUnit: 'pcs' })).toContain('Change: -10 pcs');
  });

  it('formats report captions', () => {
    expect(formatReportCaption(12, '2026-09-01T00:00:00.000Z', '2026-09-18T00:00:00.000Z', true)).toContain('Range limited to the latest 90 days.');
  });

  it('formats low-stock quantities, threshold, and operation with units', () => {
    expect(formatLowStockAlert({ itemName: 'Indomie', locationName: 'Toko A', quantity: 4, baseUnit: 'pcs', threshold: 5, operation: 'downward_adjustment' }))
      .toBe('⚠️ Low stock\n\nIndomie at Toko A\nRemaining: 4 pcs\nThreshold: 5 pcs\nAfter: Downward adjustment');
  });
});
