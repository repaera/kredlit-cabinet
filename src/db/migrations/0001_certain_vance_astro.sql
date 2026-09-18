CREATE TABLE "intent_executions" (
	"tenant_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "intent_executions_tenant_id_intent_id_pk" PRIMARY KEY("tenant_id","intent_id")
);
--> statement-breakpoint
ALTER TABLE "intent_executions" ADD CONSTRAINT "intent_executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;