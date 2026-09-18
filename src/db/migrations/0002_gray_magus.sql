DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "stock_transactions"
		WHERE "external_order_id" IS NOT NULL
		GROUP BY "tenant_id", "source", "external_order_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Cannot create tenant-scoped idempotency index: duplicate tenant/source/order rows exist';
	END IF;
END $$;--> statement-breakpoint
DROP INDEX "uniq_idempotency";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_idempotency" ON "stock_transactions" USING btree ("tenant_id","source","external_order_id") WHERE "stock_transactions"."external_order_id" is not null;
