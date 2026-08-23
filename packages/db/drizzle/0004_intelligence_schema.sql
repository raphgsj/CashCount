CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"event_type" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_actor_type_ck" CHECK ("audit_event"."actor_type" in ('USER', 'SYSTEM', 'WORKER', 'MCP', 'ANONYMOUS')),
	CONSTRAINT "audit_event_event_type_nonempty_ck" CHECK (length(trim("audit_event"."event_type")) > 0),
	CONSTRAINT "audit_event_details_shape_ck" CHECK (jsonb_typeof("audit_event"."details") = 'object'),
	CONSTRAINT "audit_event_details_length_ck" CHECK (octet_length("audit_event"."details"::text) <= 20000)
);
--> statement-breakpoint
CREATE TABLE "classification_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"financial_transaction_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_reference" text NOT NULL,
	"classification_rule_id" uuid,
	"category_id" uuid,
	"merchant_id" uuid,
	"financial_role" text,
	"confidence" numeric(5, 4),
	"input_fingerprint" char(64) NOT NULL,
	"rationale" text NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_decision_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "classification_decision_evaluation_uq" UNIQUE("workspace_id","financial_transaction_id","source","source_reference","input_fingerprint"),
	CONSTRAINT "classification_decision_source_ck" CHECK ("classification_decision"."source" in ('RULE', 'MERCHANT', 'PROVIDER', 'MODEL', 'USER')),
	CONSTRAINT "classification_decision_source_reference_nonempty_ck" CHECK (length(trim("classification_decision"."source_reference")) > 0),
	CONSTRAINT "classification_decision_rule_source_ck" CHECK (("classification_decision"."source" = 'RULE' and "classification_decision"."classification_rule_id" is not null) or ("classification_decision"."source" <> 'RULE' and "classification_decision"."classification_rule_id" is null)),
	CONSTRAINT "classification_decision_financial_role_ck" CHECK ("classification_decision"."financial_role" is null or "classification_decision"."financial_role" in ('PURCHASE', 'INCOME', 'TRANSFER', 'CARD_BILL_PAYMENT', 'REFUND', 'FEE', 'TAX', 'CASH_WITHDRAWAL', 'ADJUSTMENT', 'INVESTMENT_MOVEMENT', 'CREDIT', 'UNKNOWN_CREDIT', 'UNKNOWN')),
	CONSTRAINT "classification_decision_confidence_ck" CHECK ("classification_decision"."confidence" is null or "classification_decision"."confidence" between 0 and 1),
	CONSTRAINT "classification_decision_input_fingerprint_ck" CHECK ("classification_decision"."input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "classification_decision_rationale_length_ck" CHECK (length("classification_decision"."rationale") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "classification_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"stop_processing" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"hit_count" bigint DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_rule_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "classification_rule_name_nonempty_ck" CHECK (length(trim("classification_rule"."name")) > 0),
	CONSTRAINT "classification_rule_source_ck" CHECK ("classification_rule"."source" in ('USER', 'SYSTEM_SUGGESTION', 'IMPORT')),
	CONSTRAINT "classification_rule_hit_count_ck" CHECK ("classification_rule"."hit_count" >= 0),
	CONSTRAINT "classification_rule_json_shape_ck" CHECK (jsonb_typeof("classification_rule"."conditions") = 'object' and jsonb_typeof("classification_rule"."actions") = 'object'),
	CONSTRAINT "classification_rule_json_length_ck" CHECK (octet_length("classification_rule"."conditions"::text) <= 20000 and octet_length("classification_rule"."actions"::text) <= 20000)
);
--> statement-breakpoint
CREATE TABLE "installment_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"merchant_id" uuid,
	"currency" char(3) NOT NULL,
	"total_installments" integer NOT NULL,
	"highest_confirmed_installment" integer DEFAULT 0 NOT NULL,
	"estimated_installment_amount" numeric(20, 6),
	"original_total_amount" numeric(20, 6),
	"purchase_date" date,
	"status" text DEFAULT 'CANDIDATE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installment_series_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "installment_series_currency_ck" CHECK ("installment_series"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "installment_series_total_installments_ck" CHECK ("installment_series"."total_installments" > 0),
	CONSTRAINT "installment_series_progress_ck" CHECK ("installment_series"."highest_confirmed_installment" between 0 and "installment_series"."total_installments"),
	CONSTRAINT "installment_series_amounts_ck" CHECK (("installment_series"."estimated_installment_amount" is null or "installment_series"."estimated_installment_amount" >= 0) and ("installment_series"."original_total_amount" is null or "installment_series"."original_total_amount" >= 0)),
	CONSTRAINT "installment_series_status_ck" CHECK ("installment_series"."status" in ('CANDIDATE', 'CONFIRMED', 'NEEDS_REVIEW', 'COMPLETED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"category_id" uuid,
	"cadence" text NOT NULL,
	"expected_interval_days" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_min" numeric(20, 6) NOT NULL,
	"amount_max" numeric(20, 6) NOT NULL,
	"amount_average" numeric(20, 6) NOT NULL,
	"last_occurrence_date" date NOT NULL,
	"next_expected_date" date,
	"confidence" numeric(5, 4) NOT NULL,
	"status" text DEFAULT 'CANDIDATE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_series_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurring_series_cadence_ck" CHECK ("recurring_series"."cadence" in ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'CUSTOM')),
	CONSTRAINT "recurring_series_interval_ck" CHECK ("recurring_series"."expected_interval_days" > 0),
	CONSTRAINT "recurring_series_currency_ck" CHECK ("recurring_series"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "recurring_series_amounts_ck" CHECK ("recurring_series"."amount_min" >= 0 and "recurring_series"."amount_average" between "recurring_series"."amount_min" and "recurring_series"."amount_max"),
	CONSTRAINT "recurring_series_confidence_ck" CHECK ("recurring_series"."confidence" between 0 and 1),
	CONSTRAINT "recurring_series_status_ck" CHECK ("recurring_series"."status" in ('CANDIDATE', 'CONFIRMED', 'REJECTED', 'ENDED'))
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "tag_workspace_normalized_name_uq" UNIQUE("workspace_id","normalized_name"),
	CONSTRAINT "tag_name_nonempty_ck" CHECK (length(trim("tag"."name")) > 0),
	CONSTRAINT "tag_normalized_name_nonempty_ck" CHECK (length(trim("tag"."normalized_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "transaction_tag" (
	"workspace_id" uuid NOT NULL,
	"financial_transaction_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_tag_pk" PRIMARY KEY("workspace_id","financial_transaction_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "financial_transaction" DROP CONSTRAINT "financial_transaction_future_series_unset_ck";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classification_decision" ADD CONSTRAINT "classification_decision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classification_decision" ADD CONSTRAINT "classification_decision_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classification_decision" ADD CONSTRAINT "classification_decision_workspace_transaction_fk" FOREIGN KEY ("workspace_id","financial_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classification_decision" ADD CONSTRAINT "classification_decision_workspace_rule_fk" FOREIGN KEY ("workspace_id","classification_rule_id") REFERENCES "public"."classification_rule"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classification_decision" ADD CONSTRAINT "classification_decision_workspace_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchant"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "classification_rule" ADD CONSTRAINT "classification_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "installment_series" ADD CONSTRAINT "installment_series_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "installment_series" ADD CONSTRAINT "installment_series_workspace_financial_account_fk" FOREIGN KEY ("workspace_id","financial_account_id") REFERENCES "public"."financial_account"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "installment_series" ADD CONSTRAINT "installment_series_workspace_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchant"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_workspace_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchant"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_tag" ADD CONSTRAINT "transaction_tag_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_tag" ADD CONSTRAINT "transaction_tag_workspace_transaction_fk" FOREIGN KEY ("workspace_id","financial_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_tag" ADD CONSTRAINT "transaction_tag_workspace_tag_fk" FOREIGN KEY ("workspace_id","tag_id") REFERENCES "public"."tag"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "audit_event_workspace_created_idx" ON "audit_event" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_event_type_created_idx" ON "audit_event" USING btree ("event_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "classification_rule_workspace_active_priority_idx" ON "classification_rule" USING btree ("workspace_id","is_active","priority" DESC NULLS LAST,"created_at","id");--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_installment_series_fk" FOREIGN KEY ("workspace_id","installment_series_id") REFERENCES "public"."installment_series"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_recurring_series_fk" FOREIGN KEY ("workspace_id","recurring_series_id") REFERENCES "public"."recurring_series"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;
--> statement-breakpoint
CREATE TRIGGER recurring_series_category_visibility_trg
BEFORE INSERT OR UPDATE OF workspace_id, category_id
ON recurring_series
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_category_reference('category_id');
--> statement-breakpoint
CREATE TRIGGER classification_decision_category_visibility_trg
BEFORE INSERT OR UPDATE OF workspace_id, category_id
ON classification_decision
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_category_reference('category_id');
