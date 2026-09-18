import * as v from 'valibot';

export const WriteToolNameSchema = v.picklist(['create_location', 'create_item', 'add_stock', 'remove_stock', 'transfer_stock', 'adjust_stock', 'set_reorder_threshold']);
export const IntentQueueMessageSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  tenantId: v.pipe(v.string(), v.uuid()),
  chatId: v.string(),
  userId: v.pipe(v.string(), v.uuid()),
  toolName: WriteToolNameSchema,
  toolInput: v.record(v.string(), v.unknown()),
  requiresConfirmation: v.boolean(),
  enqueuedAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type WriteToolName = v.InferOutput<typeof WriteToolNameSchema>;
export type IntentQueueMessage = v.InferOutput<typeof IntentQueueMessageSchema>;
export const LocationFieldSchema = v.picklist(['locationId', 'fromLocationId', 'toLocationId']);
export type LocationField = v.InferOutput<typeof LocationFieldSchema>;
export const PendingActionWorkflowParamsSchema = v.object({
  pendingActionId: v.pipe(v.string(), v.minLength(1)),
  tenantId: v.pipe(v.string(), v.uuid()),
  chatId: v.pipe(v.string(), v.minLength(1)),
  userId: v.pipe(v.string(), v.uuid()),
  kind: v.picklist(['location_disambiguation', 'confirmation']),
  intent: v.record(v.string(), v.unknown()),
  missingLocationField: v.optional(LocationFieldSchema),
  timeoutMinutes: v.pipe(v.number(), v.minValue(Number.EPSILON)),
});
export const WorkflowUserResponseSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('location_disambiguation'), field: LocationFieldSchema, locationId: v.pipe(v.string(), v.uuid()) }),
  v.strictObject({ kind: v.literal('confirmation'), confirmed: v.boolean() }),
]);
export type PendingActionWorkflowParams = v.InferOutput<typeof PendingActionWorkflowParamsSchema>;
export type WorkflowUserResponse = v.InferOutput<typeof WorkflowUserResponseSchema>;
