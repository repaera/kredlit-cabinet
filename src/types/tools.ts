import * as v from 'valibot';

const Id = v.pipe(v.string(), v.minLength(1));
const NonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));
const PositiveNumber = v.pipe(v.number(), v.minValue(Number.EPSILON));
const Metadata = v.record(v.string(), v.unknown());

export const ToolContextSchema = v.object({ tenantId: Id, chatId: Id, userId: Id });
const context = ToolContextSchema.entries;

export const CreateLocationInputSchema = v.object({ ...context, name: Id, type: v.picklist(['physical', 'own_website', 'marketplace']) });
export const CreateLocationOutputSchema = v.object({ locationId: Id, name: Id, type: Id });

export const CreateItemInputSchema = v.object({
  ...context,
  name: Id,
  baseUnit: Id,
  defaultReorderThreshold: v.optional(NonNegativeInteger),
  units: v.optional(v.array(v.object({ unitName: Id, conversionToBase: PositiveNumber }))),
});
export const CreateItemOutputSchema = v.object({ itemId: Id, name: Id, baseUnit: Id });

export const CheckStockInputSchema = v.object({ ...context, itemNameOrId: Id, locationId: v.optional(Id) });
const StockItemSchema = v.object({ id: Id, name: Id, baseUnit: Id });
export const CheckStockOutputSchema = v.object({
  item: StockItemSchema,
  levels: v.array(v.object({
    locationId: Id,
    locationName: Id,
    quantity: v.number(),
    displayUnit: v.optional(v.object({ unitName: Id, quantity: v.number() })),
  })),
});

const quantityInput = { ...context, itemNameOrId: Id, locationId: Id, quantity: PositiveNumber, unit: v.optional(Id) };
export const AddStockInputSchema = v.object({ ...quantityInput, metadata: v.optional(Metadata) });
export const AddStockOutputSchema = v.object({ transactionId: Id, itemId: Id, locationId: Id, newQuantity: NonNegativeInteger });

export const RemoveStockInputSchema = v.object({
  ...quantityInput,
  source: v.picklist(['offline', 'online', 'marketplace']),
  externalOrderId: v.optional(Id),
});
export const RemoveStockOutputSchema = v.variant('ok', [
  v.object({ ok: v.literal(true), transactionId: Id, newQuantity: NonNegativeInteger }),
  v.object({ ok: v.literal(false), error: v.literal('insufficient_stock'), availableQuantity: NonNegativeInteger }),
  v.object({ ok: v.literal(false), error: v.literal('duplicate_order'), existingTransactionId: Id }),
]);

export const TransferStockInputSchema = v.object({
  ...context,
  itemNameOrId: Id,
  fromLocationId: Id,
  toLocationId: Id,
  quantity: PositiveNumber,
  unit: v.optional(Id),
});
export const TransferStockOutputSchema = v.variant('ok', [
  v.object({ ok: v.literal(true), transferId: Id, fromNewQuantity: NonNegativeInteger, toNewQuantity: NonNegativeInteger }),
  v.object({ ok: v.literal(false), error: v.literal('insufficient_stock'), availableQuantity: NonNegativeInteger }),
]);

export const AdjustStockInputSchema = v.object({ ...context, itemNameOrId: Id, locationId: Id, newQuantity: NonNegativeInteger, unit: v.optional(Id), reason: Id });
export const AdjustStockOutputSchema = v.object({ transactionId: Id, oldQuantity: NonNegativeInteger, newQuantity: NonNegativeInteger, delta: v.number() });

export const SetReorderThresholdInputSchema = v.object({ ...context, itemNameOrId: Id, locationId: v.optional(Id), threshold: NonNegativeInteger });
export const SetReorderThresholdOutputSchema = v.object({ itemId: Id, locationId: v.optional(Id), threshold: NonNegativeInteger });

export const ListLowStockInputSchema = v.object({ ...context, locationId: v.optional(Id) });
export const ListLowStockOutputSchema = v.object({ items: v.array(v.object({
  itemId: Id, itemName: Id, locationId: Id, locationName: Id,
  quantity: NonNegativeInteger, threshold: NonNegativeInteger,
})) });

export const GetItemHistoryInputSchema = v.object({ ...context, itemNameOrId: v.optional(Id), locationId: v.optional(Id), dateFrom: v.optional(v.pipe(v.string(), v.isoDate())), dateTo: v.optional(v.pipe(v.string(), v.isoDate())) });
export const GetItemHistoryOutputSchema = v.object({ transactions: v.array(v.object({
  id: Id, type: Id, quantity: v.number(), locationId: Id, source: v.optional(Id), metadata: Metadata, createdAt: Id,
})) });

export const ExportStockReportInputSchema = v.object({ ...context, locationId: v.optional(Id), itemNameOrId: v.optional(Id), dateFrom: v.optional(v.pipe(v.string(), v.isoDate())), dateTo: v.optional(v.pipe(v.string(), v.isoDate())) });
export const ExportStockReportOutputSchema = v.object({ fileName: Id, fileBytes: v.instance(Uint8Array), rowCount: NonNegativeInteger, rangeUsed: v.object({ from: Id, to: Id }), clamped: v.boolean() });

export type ToolContext = v.InferOutput<typeof ToolContextSchema>;
export type CreateLocationInput = v.InferOutput<typeof CreateLocationInputSchema>;
export type CreateItemInput = v.InferOutput<typeof CreateItemInputSchema>;
export type CheckStockInput = v.InferOutput<typeof CheckStockInputSchema>;
export type AddStockInput = v.InferOutput<typeof AddStockInputSchema>;
export type RemoveStockInput = v.InferOutput<typeof RemoveStockInputSchema>;
export type TransferStockInput = v.InferOutput<typeof TransferStockInputSchema>;
export type AdjustStockInput = v.InferOutput<typeof AdjustStockInputSchema>;
export type SetReorderThresholdInput = v.InferOutput<typeof SetReorderThresholdInputSchema>;
export type ListLowStockInput = v.InferOutput<typeof ListLowStockInputSchema>;
export type GetItemHistoryInput = v.InferOutput<typeof GetItemHistoryInputSchema>;
export type ExportStockReportInput = v.InferOutput<typeof ExportStockReportInputSchema>;
export type WriteToolOutput =
  | v.InferOutput<typeof CreateLocationOutputSchema>
  | v.InferOutput<typeof CreateItemOutputSchema>
  | v.InferOutput<typeof AddStockOutputSchema>
  | v.InferOutput<typeof RemoveStockOutputSchema>
  | v.InferOutput<typeof TransferStockOutputSchema>
  | v.InferOutput<typeof AdjustStockOutputSchema>
  | v.InferOutput<typeof SetReorderThresholdOutputSchema>;
