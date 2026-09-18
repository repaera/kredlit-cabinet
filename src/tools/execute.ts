import type { Sql, TransactionSql } from 'postgres';
import * as v from 'valibot';
import type { Db } from '../db/client.ts';
import { clampExportRange } from '../lib/date-range.ts';
import { buildWorkbook } from '../lib/xlsx-report.ts';
import { toBase } from '../lib/units.ts';
import {
  AddStockInputSchema, AddStockOutputSchema, AdjustStockInputSchema, AdjustStockOutputSchema,
  CheckStockInputSchema, CheckStockOutputSchema, CreateItemInputSchema, CreateItemOutputSchema,
  CreateLocationInputSchema, CreateLocationOutputSchema, ExportStockReportInputSchema, ExportStockReportOutputSchema,
  GetItemHistoryInputSchema, GetItemHistoryOutputSchema, ListLowStockInputSchema, ListLowStockOutputSchema,
  RemoveStockInputSchema, RemoveStockOutputSchema, SetReorderThresholdInputSchema, SetReorderThresholdOutputSchema,
  TransferStockInputSchema, TransferStockOutputSchema,
  type AddStockInput, type AdjustStockInput, type CheckStockInput, type CreateItemInput, type CreateLocationInput,
  type ExportStockReportInput, type GetItemHistoryInput, type ListLowStockInput, type RemoveStockInput,
  type SetReorderThresholdInput, type TransferStockInput, type WriteToolOutput,
} from '../types/tools.ts';
import type { WriteToolName } from '../types/flow.ts';

type AnySql = Sql<Record<string, never>> | TransactionSql<Record<string, never>>;
type Tx = TransactionSql<Record<string, never>>;

async function inTransaction<T>(db: AnySql, run: (tx: Tx) => Promise<T>): Promise<T> {
  return 'begin' in db ? await db.begin(run) as T : run(db);
}

async function boundary<I, O>(inputSchema: v.GenericSchema<unknown, I>, outputSchema: v.GenericSchema<unknown, O>, input: unknown, run: (parsed: I) => Promise<unknown>): Promise<O> {
  return v.parse(outputSchema, await run(v.parse(inputSchema, input)));
}

async function resolveItem(db: AnySql, tenantId: string, nameOrId: string) {
  const [item] = await db<{ id: string; name: string; base_unit: string }[]>`
    select id, name, base_unit from items
    where tenant_id = ${tenantId} and (id::text = ${nameOrId} or lower(name) = lower(${nameOrId}))
    limit 1`;
  if (!item) throw new Error(`Item not found: ${nameOrId}`);
  return item;
}

async function assertLocation(db: AnySql, tenantId: string, locationId: string) {
  const [location] = await db<{ id: string; name: string }[]>`
    select id, name from locations where id = ${locationId} and tenant_id = ${tenantId}`;
  if (!location) throw new Error(`Location not found: ${locationId}`);
  return location;
}

async function baseQuantity(db: AnySql, item: { id: string; base_unit: string }, quantity: number, unit?: string) {
  if (!unit || unit.toLocaleLowerCase() === item.base_unit.toLocaleLowerCase()) return toBase(quantity, 1);
  const [row] = await db<{ conversion_to_base: string }[]>`
    select conversion_to_base from item_units where item_id = ${item.id} and lower(unit_name) = lower(${unit})`;
  if (!row) throw new Error(`Unit not configured for item: ${unit}`);
  return toBase(quantity, Number(row.conversion_to_base));
}

export function createLocation(db: AnySql, input: unknown) {
  return boundary(CreateLocationInputSchema, CreateLocationOutputSchema, input, async ({ tenantId, name, type }) => {
    const [row] = await db<{ id: string; name: string; type: string }[]>`
      insert into locations (tenant_id, name, type) values (${tenantId}, ${name}, ${type})
      returning id, name, type`;
    return { locationId: row.id, name: row.name, type: row.type };
  });
}

export function createItem(db: AnySql, input: unknown) {
  return boundary(CreateItemInputSchema, CreateItemOutputSchema, input, async (data: CreateItemInput) => inTransaction(db, async (tx) => {
    const [row] = await tx<{ id: string; name: string; base_unit: string }[]>`
      insert into items (tenant_id, name, base_unit, default_reorder_threshold)
      values (${data.tenantId}, ${data.name}, ${data.baseUnit}, ${data.defaultReorderThreshold ?? null})
      returning id, name, base_unit`;
    for (const unit of data.units ?? []) {
      await tx`insert into item_units (item_id, unit_name, conversion_to_base) values (${row.id}, ${unit.unitName}, ${unit.conversionToBase})`;
    }
    return { itemId: row.id, name: row.name, baseUnit: row.base_unit };
  }));
}

export function checkStock(db: Db, input: unknown) {
  return boundary(CheckStockInputSchema, CheckStockOutputSchema, input, async (data: CheckStockInput) => {
    const item = await resolveItem(db, data.tenantId, data.itemNameOrId);
    const levels = await db<{ location_id: string; location_name: string; quantity: number }[]>`
      select l.id location_id, l.name location_name, coalesce(sl.quantity, 0)::int quantity
      from locations l left join stock_levels sl on sl.location_id = l.id and sl.item_id = ${item.id}
      where l.tenant_id = ${data.tenantId} ${data.locationId ? db`and l.id = ${data.locationId}` : db``}
      order by l.name`;
    const units = await db<{ unit_name: string; conversion_to_base: string }[]>`
      select unit_name, conversion_to_base from item_units where item_id = ${item.id} order by conversion_to_base::numeric desc`;
    return {
      item: { id: item.id, name: item.name, baseUnit: item.base_unit },
      levels: levels.map((level) => {
        const display = units.find((unit) => Number(unit.conversion_to_base) > 1 && level.quantity >= Number(unit.conversion_to_base));
        return {
          locationId: level.location_id,
          locationName: level.location_name,
          quantity: level.quantity,
          ...(display ? { displayUnit: { unitName: display.unit_name, quantity: level.quantity / Number(display.conversion_to_base) } } : {}),
        };
      }),
    };
  });
}

export function addStock(db: AnySql, input: unknown) {
  return boundary(AddStockInputSchema, AddStockOutputSchema, input, async (data: AddStockInput) => inTransaction(db, async (tx) => {
    const item = await resolveItem(tx, data.tenantId, data.itemNameOrId);
    await assertLocation(tx, data.tenantId, data.locationId);
    const quantity = await baseQuantity(tx, item, data.quantity, data.unit);
    const [level] = await tx<{ quantity: number }[]>`
      insert into stock_levels (item_id, location_id, quantity) values (${item.id}, ${data.locationId}, ${quantity})
      on conflict (item_id, location_id) do update set quantity = stock_levels.quantity + excluded.quantity
      returning quantity`;
    const [transaction] = await tx<{ id: string }[]>`
      insert into stock_transactions (tenant_id, item_id, location_id, type, quantity, metadata, created_by)
      values (${data.tenantId}, ${item.id}, ${data.locationId}, 'in', ${quantity}, ${tx.json({ ...data.metadata, inputUnit: data.unit ?? item.base_unit, inputQuantity: data.quantity })}, ${data.userId}) returning id`;
    return { transactionId: transaction.id, itemId: item.id, locationId: data.locationId, newQuantity: level.quantity };
  }));
}

export function removeStock(db: AnySql, input: unknown) {
  return boundary(RemoveStockInputSchema, RemoveStockOutputSchema, input, async (data: RemoveStockInput) => inTransaction(db, async (tx) => {
    if (data.source !== 'offline' && !data.externalOrderId) throw new Error('externalOrderId is required for online and marketplace sales');
    const item = await resolveItem(tx, data.tenantId, data.itemNameOrId);
    await assertLocation(tx, data.tenantId, data.locationId);
    const quantity = await baseQuantity(tx, item, data.quantity, data.unit);
    if (data.externalOrderId) {
      const [existing] = await tx<{ id: string }[]>`select id from stock_transactions where tenant_id = ${data.tenantId} and source = ${data.source} and external_order_id = ${data.externalOrderId!}`;
      if (existing) return { ok: false as const, error: 'duplicate_order' as const, existingTransactionId: existing.id };
    }
    const [level] = await tx<{ quantity: number }[]>`
      update stock_levels set quantity = quantity - ${quantity}
      where item_id = ${item.id} and location_id = ${data.locationId} and quantity >= ${quantity}
      returning quantity`;
    if (!level) {
      const [current] = await tx<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${item.id} and location_id = ${data.locationId}`;
      return { ok: false as const, error: 'insufficient_stock' as const, availableQuantity: current?.quantity ?? 0 };
    }
    const [transaction] = await tx<{ id: string }[]>`
      insert into stock_transactions (tenant_id, item_id, location_id, type, quantity, source, external_order_id, metadata, created_by)
      values (${data.tenantId}, ${item.id}, ${data.locationId}, 'out', ${-quantity}, ${data.source}, ${data.externalOrderId ?? null}, ${tx.json({ inputUnit: data.unit ?? item.base_unit, inputQuantity: data.quantity })}, ${data.userId})
      on conflict (tenant_id, source, external_order_id) where external_order_id is not null do nothing returning id`;
    if (!transaction) {
      await tx`update stock_levels set quantity = quantity + ${quantity} where item_id = ${item.id} and location_id = ${data.locationId}`;
      const [existing] = await tx<{ id: string }[]>`select id from stock_transactions where tenant_id = ${data.tenantId} and source = ${data.source} and external_order_id = ${data.externalOrderId!}`;
      return { ok: false as const, error: 'duplicate_order' as const, existingTransactionId: existing.id };
    }
    return { ok: true as const, transactionId: transaction.id, newQuantity: level.quantity };
  }));
}

export function transferStock(db: AnySql, input: unknown, failAfterDebit = false) {
  return boundary(TransferStockInputSchema, TransferStockOutputSchema, input, async (data: TransferStockInput) => {
    if (data.fromLocationId === data.toLocationId) throw new Error('Transfer locations must differ');
    return inTransaction(db, async (tx) => {
      const item = await resolveItem(tx, data.tenantId, data.itemNameOrId);
      await assertLocation(tx, data.tenantId, data.fromLocationId);
      await assertLocation(tx, data.tenantId, data.toLocationId);
      const quantity = await baseQuantity(tx, item, data.quantity, data.unit);
      const [source] = await tx<{ quantity: number }[]>`
        update stock_levels set quantity = quantity - ${quantity}
        where item_id = ${item.id} and location_id = ${data.fromLocationId} and quantity >= ${quantity}
        returning quantity`;
      if (!source) {
        const [current] = await tx<{ quantity: number }[]>`select quantity from stock_levels where item_id = ${item.id} and location_id = ${data.fromLocationId}`;
        return { ok: false as const, error: 'insufficient_stock' as const, availableQuantity: current?.quantity ?? 0 };
      }
      if (failAfterDebit) throw new Error('forced transfer failure');
      const [destination] = await tx<{ quantity: number }[]>`
        insert into stock_levels (item_id, location_id, quantity) values (${item.id}, ${data.toLocationId}, ${quantity})
        on conflict (item_id, location_id) do update set quantity = stock_levels.quantity + excluded.quantity
        returning quantity`;
      const transferId = crypto.randomUUID();
      await tx`
        insert into stock_transactions (tenant_id, item_id, location_id, type, quantity, transfer_id, metadata, created_by)
        values
          (${data.tenantId}, ${item.id}, ${data.fromLocationId}, 'transfer', ${-quantity}, ${transferId}, ${tx.json({ inputUnit: data.unit ?? item.base_unit, inputQuantity: data.quantity })}, ${data.userId}),
          (${data.tenantId}, ${item.id}, ${data.toLocationId}, 'transfer', ${quantity}, ${transferId}, ${tx.json({ inputUnit: data.unit ?? item.base_unit, inputQuantity: data.quantity })}, ${data.userId})`;
      return { ok: true as const, transferId, fromNewQuantity: source.quantity, toNewQuantity: destination.quantity };
    });
  });
}

export function adjustStock(db: AnySql, input: unknown) {
  return boundary(AdjustStockInputSchema, AdjustStockOutputSchema, input, async (data: AdjustStockInput) => inTransaction(db, async (tx) => {
    const item = await resolveItem(tx, data.tenantId, data.itemNameOrId);
    await assertLocation(tx, data.tenantId, data.locationId);
    const newQuantity = await baseQuantity(tx, item, data.newQuantity, data.unit);
    const [result] = await tx<{ old_quantity: number; quantity: number }[]>`
      with old as materialized (
        select quantity from stock_levels where item_id = ${item.id} and location_id = ${data.locationId} for update
      ), changed as (
        insert into stock_levels (item_id, location_id, quantity)
        select ${item.id}, ${data.locationId}, ${newQuantity} + coalesce(old.quantity * 0, 0)
        from (select 1) seed left join old on true
        on conflict (item_id, location_id) do update set quantity = excluded.quantity returning quantity
      ) select coalesce((select quantity from old), 0)::int old_quantity, quantity from changed`;
    const delta = result.quantity - result.old_quantity;
    const [transaction] = await tx<{ id: string }[]>`
      insert into stock_transactions (tenant_id, item_id, location_id, type, quantity, metadata, created_by)
      values (${data.tenantId}, ${item.id}, ${data.locationId}, 'adjustment', ${delta}, ${tx.json({ reason: data.reason, inputUnit: data.unit ?? item.base_unit, inputQuantity: data.newQuantity })}, ${data.userId}) returning id`;
    return { transactionId: transaction.id, oldQuantity: result.old_quantity, newQuantity: result.quantity, delta };
  }));
}

export function setReorderThreshold(db: AnySql, input: unknown) {
  return boundary(SetReorderThresholdInputSchema, SetReorderThresholdOutputSchema, input, async (data: SetReorderThresholdInput) => {
    const item = await resolveItem(db, data.tenantId, data.itemNameOrId);
    if (data.locationId) {
      await assertLocation(db, data.tenantId, data.locationId);
      await db`insert into stock_levels (item_id, location_id, reorder_threshold) values (${item.id}, ${data.locationId}, ${data.threshold}) on conflict (item_id, location_id) do update set reorder_threshold = excluded.reorder_threshold`;
    } else {
      await db`update items set default_reorder_threshold = ${data.threshold} where id = ${item.id} and tenant_id = ${data.tenantId}`;
    }
    return { itemId: item.id, ...(data.locationId ? { locationId: data.locationId } : {}), threshold: data.threshold };
  });
}

export function listLowStock(db: Db, input: unknown) {
  return boundary(ListLowStockInputSchema, ListLowStockOutputSchema, input, async (data: ListLowStockInput) => ({
    items: await db<{ itemId: string; itemName: string; locationId: string; locationName: string; quantity: number; threshold: number }[]>`
      select i.id "itemId", i.name "itemName", l.id "locationId", l.name "locationName", sl.quantity::int quantity,
             coalesce(sl.reorder_threshold, i.default_reorder_threshold)::int threshold
      from stock_levels sl join items i on i.id = sl.item_id join locations l on l.id = sl.location_id
      where i.tenant_id = ${data.tenantId}
        and coalesce(sl.reorder_threshold, i.default_reorder_threshold) is not null
        and sl.quantity < coalesce(sl.reorder_threshold, i.default_reorder_threshold)
        ${data.locationId ? db`and l.id = ${data.locationId}` : db``}
      order by l.name, i.name`,
  }));
}

export function getItemHistory(db: Db, input: unknown) {
  return boundary(GetItemHistoryInputSchema, GetItemHistoryOutputSchema, input, async (data: GetItemHistoryInput) => {
    const item = data.itemNameOrId ? await resolveItem(db, data.tenantId, data.itemNameOrId) : null;
    const rows = await db<{ id: string; type: string; quantity: number; location_id: string; source: string | null; metadata: Record<string, unknown>; created_at: Date }[]>`
      select id, type, quantity::int, location_id, source, metadata, created_at from stock_transactions
      where tenant_id = ${data.tenantId}
        ${item ? db`and item_id = ${item.id}` : db``}
        ${data.locationId ? db`and location_id = ${data.locationId}` : db``}
        ${data.dateFrom ? db`and created_at >= ${data.dateFrom}::date` : db``}
        ${data.dateTo ? db`and created_at < (${data.dateTo}::date + interval '1 day')` : db``}
      order by created_at desc`;
    return { transactions: rows.map((row) => ({ id: row.id, type: row.type, quantity: row.quantity, locationId: row.location_id, ...(row.source ? { source: row.source } : {}), metadata: row.metadata, createdAt: row.created_at.toISOString() })) };
  });
}

export function exportStockReport(db: Db, input: unknown, now?: Date) {
  return boundary(ExportStockReportInputSchema, ExportStockReportOutputSchema, input, async (data: ExportStockReportInput) => {
    const range = clampExportRange(data.dateFrom, data.dateTo, now);
    const item = data.itemNameOrId ? await resolveItem(db, data.tenantId, data.itemNameOrId) : null;
    const rows = await db<{ created_at: Date; item: string; location: string; type: string; quantity: number; source: string | null; external_order_id: string | null }[]>`
      select st.created_at, i.name item, l.name location, st.type, st.quantity::int, st.source, st.external_order_id
      from stock_transactions st join items i on i.id = st.item_id join locations l on l.id = st.location_id
      where st.tenant_id = ${data.tenantId} and st.created_at between ${range.from} and ${range.to}
        ${item ? db`and st.item_id = ${item.id}` : db``}
        ${data.locationId ? db`and st.location_id = ${data.locationId}` : db``}
      order by st.created_at`;
    const fileBytes = buildWorkbook(rows.map((row) => ({
      createdAt: row.created_at.toISOString(), item: row.item, location: row.location, type: row.type,
      quantity: row.quantity, source: row.source ?? '', externalOrderId: row.external_order_id ?? '',
    })));
    return { fileName: `cabinet-export-${range.to.slice(0, 10)}.xlsx`, fileBytes, rowCount: rows.length, rangeUsed: { from: range.from, to: range.to }, clamped: range.clamped };
  });
}

export async function lowStockAt(db: Db, tenantId: string, itemId: string, locationId: string) {
  const [row] = await db<{ item_name: string; location_name: string; quantity: number; threshold: number }[]>`
    select i.name item_name, l.name location_name, sl.quantity::int quantity,
           coalesce(sl.reorder_threshold, i.default_reorder_threshold)::int threshold
    from stock_levels sl join items i on i.id = sl.item_id join locations l on l.id = sl.location_id
    where i.tenant_id = ${tenantId} and i.id = ${itemId} and l.id = ${locationId}
      and coalesce(sl.reorder_threshold, i.default_reorder_threshold) is not null
      and sl.quantity < coalesce(sl.reorder_threshold, i.default_reorder_threshold)`;
  return row;
}

export function parseWriteToolOutput(name: WriteToolName, output: unknown): WriteToolOutput {
  switch (name) {
    case 'create_location': return v.parse(CreateLocationOutputSchema, output);
    case 'create_item': return v.parse(CreateItemOutputSchema, output);
    case 'add_stock': return v.parse(AddStockOutputSchema, output);
    case 'remove_stock': return v.parse(RemoveStockOutputSchema, output);
    case 'transfer_stock': return v.parse(TransferStockOutputSchema, output);
    case 'adjust_stock': return v.parse(AdjustStockOutputSchema, output);
    case 'set_reorder_threshold': return v.parse(SetReorderThresholdOutputSchema, output);
  }
}

export function executeWriteTool(db: Tx, name: WriteToolName, input: unknown): Promise<WriteToolOutput> {
  switch (name) {
    case 'create_location': return createLocation(db, input);
    case 'create_item': return createItem(db, input);
    case 'add_stock': return addStock(db, input);
    case 'remove_stock': return removeStock(db, input);
    case 'transfer_stock': return transferStock(db, input);
    case 'adjust_stock': return adjustStock(db, input);
    case 'set_reorder_threshold': return setReorderThreshold(db, input);
  }
}
