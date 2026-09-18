import { sql } from 'drizzle-orm';
import { index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  vertical: text('vertical').notNull().default('general'),
  settings: jsonb('settings').notNull().default({ confirmTimeoutMinutes: 10 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  telegramUserId: text('telegram_user_id').notNull(),
  displayName: text('display_name'),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('uniq_user').on(t.tenantId, t.telegramUserId)]);

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type', { enum: ['physical', 'own_website', 'marketplace'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('uniq_location_name').on(t.tenantId, t.name)]);

export const telegramChats = pgTable('telegram_chats', {
  chatId: text('chat_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  baseUnit: text('base_unit').notNull().default('pcs'),
  defaultReorderThreshold: integer('default_reorder_threshold'),
  attributes: jsonb('attributes').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('uniq_item_name').on(t.tenantId, t.name)]);

export const itemUnits = pgTable('item_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  unitName: text('unit_name').notNull(),
  conversionToBase: numeric('conversion_to_base').notNull(),
}, (t) => [unique('uniq_item_unit').on(t.itemId, t.unitName)]);

export const stockLevels = pgTable('stock_levels', {
  itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  quantity: integer('quantity').notNull().default(0),
  reorderThreshold: integer('reorder_threshold'),
}, (t) => [primaryKey({ columns: [t.itemId, t.locationId] })]);

export const stockTransactions = pgTable('stock_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  itemId: uuid('item_id').notNull().references(() => items.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  type: text('type', { enum: ['in', 'out', 'transfer', 'adjustment'] }).notNull(),
  quantity: integer('quantity').notNull(),
  source: text('source'),
  externalOrderId: text('external_order_id'),
  transferId: uuid('transfer_id'),
  metadata: jsonb('metadata').notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uniq_idempotency').on(t.tenantId, t.source, t.externalOrderId).where(sql`${t.externalOrderId} is not null`),
  index('stock_transactions_tenant_created_idx').on(t.tenantId, t.createdAt),
]);

export const intentExecutions = pgTable('intent_executions', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  intentId: uuid('intent_id').notNull(),
  toolName: text('tool_name').notNull(),
  output: jsonb('output'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.tenantId, t.intentId] })]);

export const sessionContext = pgTable('session_context', {
  chatId: text('chat_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastLocationId: uuid('last_location_id').references(() => locations.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.chatId, t.userId] })]);

export const pendingActions = pgTable('pending_actions', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['location_disambiguation', 'confirmation'] }).notNull(),
  intent: jsonb('intent').notNull(),
  missingLocationField: text('missing_location_field', { enum: ['locationId', 'fromLocationId', 'toLocationId'] }),
  workflowInstanceId: text('workflow_instance_id').notNull(),
  status: text('status', { enum: ['pending', 'resolved', 'confirmed', 'cancelled', 'expired'] }).notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [uniqueIndex('uniq_active_pending').on(t.chatId, t.userId).where(sql`${t.status} = 'pending'`)]);
