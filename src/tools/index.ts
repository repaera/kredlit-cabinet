import { env } from 'cloudflare:workers';
import { defineTool } from '@flue/runtime/tool';
import { createDb } from '../db/client.ts';
import * as schemas from '../types/tools.ts';
import * as execute from './execute.ts';
export { requiresConfirmation } from '../lib/requires-confirmation.ts';

async function withDb<T>(run: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const binding = env as unknown as { HYPERDRIVE: Hyperdrive };
  const db = createDb(binding.HYPERDRIVE.connectionString);
  try { return await run(db); } finally { await db.end(); }
}

export const checkStockTool = defineTool({ name: 'check_stock', description: 'Read current stock for an item.', input: schemas.CheckStockInputSchema, output: schemas.CheckStockOutputSchema, run: async ({ data }) => ({ output: await withDb((db) => execute.checkStock(db, data)) }) });
export const listLowStockTool = defineTool({ name: 'list_low_stock', description: 'List stock below its effective threshold.', input: schemas.ListLowStockInputSchema, output: schemas.ListLowStockOutputSchema, run: async ({ data }) => ({ output: await withDb((db) => execute.listLowStock(db, data)) }) });
export const getItemHistoryTool = defineTool({ name: 'get_item_history', description: 'Read inventory transaction history.', input: schemas.GetItemHistoryInputSchema, output: schemas.GetItemHistoryOutputSchema, run: async ({ data }) => ({ output: await withDb((db) => execute.getItemHistory(db, data)) }) });
export const exportStockReportTool = defineTool({ name: 'export_stock_report', description: 'Build a tenant-scoped Excel transaction report.', input: schemas.ExportStockReportInputSchema, output: schemas.ExportStockReportOutputSchema, run: async ({ data }) => ({ output: await withDb((db) => execute.exportStockReport(db, data)) }) });

export const readTools = [checkStockTool, listLowStockTool, getItemHistoryTool, exportStockReportTool];
