CREATE TABLE "bill_payment_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credit_card_bill_payment_id" uuid NOT NULL,
	"financial_transaction_id" uuid NOT NULL,
	"match_status" text DEFAULT 'UNMATCHED' NOT NULL,
	"match_method" text DEFAULT 'NONE' NOT NULL,
	"confidence" numeric(5, 4),
	"matched_at" timestamp with time zone,
	"confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_payment_reconciliation_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "bill_payment_reconciliation_candidate_uq" UNIQUE("workspace_id","credit_card_bill_payment_id","financial_transaction_id"),
	CONSTRAINT "bill_payment_reconciliation_status_ck" CHECK ("bill_payment_reconciliation"."match_status" in ('UNMATCHED', 'CANDIDATE', 'AUTO_MATCHED', 'USER_CONFIRMED', 'REJECTED')),
	CONSTRAINT "bill_payment_reconciliation_match_method_nonempty_ck" CHECK (length(trim("bill_payment_reconciliation"."match_method")) > 0),
	CONSTRAINT "bill_payment_reconciliation_confidence_ck" CHECK ("bill_payment_reconciliation"."confidence" is null or "bill_payment_reconciliation"."confidence" between 0 and 1),
	CONSTRAINT "bill_payment_reconciliation_matched_at_ck" CHECK ("bill_payment_reconciliation"."match_status" not in ('AUTO_MATCHED', 'USER_CONFIRMED') or "bill_payment_reconciliation"."matched_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"code" text NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name_en" text NOT NULL,
	"name_pt_br" text NOT NULL,
	"icon_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_code_nonempty_ck" CHECK (length(trim("category"."code")) > 0),
	CONSTRAINT "category_parent_not_self_ck" CHECK ("category"."parent_id" is null or "category"."parent_id" <> "category"."id"),
	CONSTRAINT "category_kind_ck" CHECK ("category"."kind" in ('EXPENSE', 'INCOME', 'TRANSFER', 'OTHER')),
	CONSTRAINT "category_name_en_nonempty_ck" CHECK (length(trim("category"."name_en")) > 0),
	CONSTRAINT "category_name_pt_br_nonempty_ck" CHECK (length(trim("category"."name_pt_br")) > 0),
	CONSTRAINT "category_code_scope_ck" CHECK (("category"."workspace_id" is null and "category"."code" !~ '^custom\.') or ("category"."workspace_id" is not null and "category"."code" ~ '^custom\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
);
--> statement-breakpoint
CREATE TABLE "credit_card_bill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_bill_id" text NOT NULL,
	"status" text NOT NULL,
	"due_date" date,
	"close_date" date,
	"total_amount" numeric(20, 6),
	"minimum_payment" numeric(20, 6),
	"currency" char(3) NOT NULL,
	"allows_installments" boolean,
	"provider_status" text,
	"reconciliation_status" text,
	"latest_raw_object_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_card_bill_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_card_bill_external_identity_uq" UNIQUE("workspace_id","provider","external_bill_id"),
	CONSTRAINT "credit_card_bill_provider_ck" CHECK ("credit_card_bill"."provider" = 'PLUGGY'),
	CONSTRAINT "credit_card_bill_external_bill_id_nonempty_ck" CHECK (length(trim("credit_card_bill"."external_bill_id")) > 0),
	CONSTRAINT "credit_card_bill_status_nonempty_ck" CHECK (length(trim("credit_card_bill"."status")) > 0),
	CONSTRAINT "credit_card_bill_currency_ck" CHECK ("credit_card_bill"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "credit_card_bill_amounts_ck" CHECK (("credit_card_bill"."total_amount" is null or "credit_card_bill"."total_amount" >= 0) and ("credit_card_bill"."minimum_payment" is null or "credit_card_bill"."minimum_payment" >= 0)),
	CONSTRAINT "credit_card_bill_reconciliation_status_length_ck" CHECK ("credit_card_bill"."reconciliation_status" is null or length("credit_card_bill"."reconciliation_status") <= 100)
);
--> statement-breakpoint
CREATE TABLE "credit_card_bill_finance_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credit_card_bill_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_charge_id" text NOT NULL,
	"charge_type" text NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"currency" char(3) NOT NULL,
	"additional_info" text,
	"matched_transaction_id" uuid,
	"latest_raw_object_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_card_bill_finance_charge_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_card_bill_finance_charge_external_identity_uq" UNIQUE("workspace_id","credit_card_bill_id","provider","external_charge_id"),
	CONSTRAINT "credit_card_bill_finance_charge_provider_ck" CHECK ("credit_card_bill_finance_charge"."provider" = 'PLUGGY'),
	CONSTRAINT "credit_card_bill_finance_charge_external_charge_id_nonempty_ck" CHECK (length(trim("credit_card_bill_finance_charge"."external_charge_id")) > 0),
	CONSTRAINT "credit_card_bill_finance_charge_charge_type_nonempty_ck" CHECK (length(trim("credit_card_bill_finance_charge"."charge_type")) > 0),
	CONSTRAINT "credit_card_bill_finance_charge_amount_ck" CHECK ("credit_card_bill_finance_charge"."amount" >= 0),
	CONSTRAINT "credit_card_bill_finance_charge_currency_ck" CHECK ("credit_card_bill_finance_charge"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "credit_card_bill_finance_charge_additional_info_length_ck" CHECK ("credit_card_bill_finance_charge"."additional_info" is null or length("credit_card_bill_finance_charge"."additional_info") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "credit_card_bill_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credit_card_bill_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_payment_id" text NOT NULL,
	"value_type" text NOT NULL,
	"payment_date" date NOT NULL,
	"payment_mode" text,
	"amount" numeric(20, 6) NOT NULL,
	"currency" char(3) NOT NULL,
	"matched_card_transaction_id" uuid,
	"latest_raw_object_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_card_bill_payment_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "credit_card_bill_payment_external_identity_uq" UNIQUE("workspace_id","credit_card_bill_id","provider","external_payment_id"),
	CONSTRAINT "credit_card_bill_payment_provider_ck" CHECK ("credit_card_bill_payment"."provider" = 'PLUGGY'),
	CONSTRAINT "credit_card_bill_payment_external_payment_id_nonempty_ck" CHECK (length(trim("credit_card_bill_payment"."external_payment_id")) > 0),
	CONSTRAINT "credit_card_bill_payment_value_type_nonempty_ck" CHECK (length(trim("credit_card_bill_payment"."value_type")) > 0),
	CONSTRAINT "credit_card_bill_payment_amount_ck" CHECK ("credit_card_bill_payment"."amount" >= 0),
	CONSTRAINT "credit_card_bill_payment_currency_ck" CHECK ("credit_card_bill_payment"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "financial_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"account_type" text NOT NULL,
	"account_subtype" text,
	"name" text NOT NULL,
	"institution_name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"masked_number" text,
	"current_balance" numeric(20, 6),
	"available_balance" numeric(20, 6),
	"credit_limit" numeric(20, 6),
	"available_credit_limit" numeric(20, 6),
	"closing_day" smallint,
	"due_day" smallint,
	"is_active" boolean DEFAULT true NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"latest_raw_object_id" uuid,
	"provider_history_earliest_date" date,
	"provider_history_latest_date" date,
	"initial_import_completed_at" timestamp with time zone,
	"history_coverage_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"history_coverage_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "financial_account_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "financial_account_external_identity_uq" UNIQUE("workspace_id","provider","external_account_id"),
	CONSTRAINT "financial_account_provider_ck" CHECK ("financial_account"."provider" = 'PLUGGY'),
	CONSTRAINT "financial_account_external_account_id_nonempty_ck" CHECK (length(trim("financial_account"."external_account_id")) > 0),
	CONSTRAINT "financial_account_type_ck" CHECK ("financial_account"."account_type" in ('CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT', 'OTHER')),
	CONSTRAINT "financial_account_name_nonempty_ck" CHECK (length(trim("financial_account"."name")) > 0),
	CONSTRAINT "financial_account_institution_name_nonempty_ck" CHECK (length(trim("financial_account"."institution_name")) > 0),
	CONSTRAINT "financial_account_currency_ck" CHECK ("financial_account"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "financial_account_masked_number_ck" CHECK ("financial_account"."masked_number" is null or "financial_account"."masked_number" ~ '^[0-9]{1,4}$'),
	CONSTRAINT "financial_account_closing_day_ck" CHECK ("financial_account"."closing_day" is null or "financial_account"."closing_day" between 1 and 31),
	CONSTRAINT "financial_account_due_day_ck" CHECK ("financial_account"."due_day" is null or "financial_account"."due_day" between 1 and 31),
	CONSTRAINT "financial_account_history_dates_ck" CHECK ("financial_account"."provider_history_earliest_date" is null or "financial_account"."provider_history_latest_date" is null or "financial_account"."provider_history_earliest_date" <= "financial_account"."provider_history_latest_date"),
	CONSTRAINT "financial_account_history_coverage_status_ck" CHECK ("financial_account"."history_coverage_status" in ('UNKNOWN', 'PARTIAL', 'PROVIDER_MAXIMUM_RETRIEVED', 'USER_EXTENDED_HISTORY')),
	CONSTRAINT "financial_account_history_coverage_note_length_ck" CHECK ("financial_account"."history_coverage_note" is null or length("financial_account"."history_coverage_note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "financial_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"financial_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_transaction_id" text,
	"provider_id" text,
	"provider_code" text,
	"status" text DEFAULT 'UNKNOWN' NOT NULL,
	"provider_type" text,
	"provider_operation_type" text,
	"provider_operation_type_additional_info" text,
	"provider_amount_signed" numeric(20, 6) NOT NULL,
	"provider_currency" char(3) NOT NULL,
	"account_currency_amount_signed" numeric(20, 6),
	"account_currency" char(3) NOT NULL,
	"system_direction" text DEFAULT 'UNKNOWN' NOT NULL,
	"system_financial_role" text DEFAULT 'UNKNOWN' NOT NULL,
	"system_is_excluded_from_spend" boolean DEFAULT false NOT NULL,
	"provider_transaction_at" timestamp with time zone NOT NULL,
	"transaction_local_date" date NOT NULL,
	"provider_purchase_at" timestamp with time zone,
	"purchase_local_date" date,
	"description_original" text NOT NULL,
	"description_raw" text,
	"description_normalized" text NOT NULL,
	"provider_category_id" text,
	"provider_category_name" text,
	"system_merchant_id" uuid,
	"system_category_id" uuid,
	"system_category_source" text DEFAULT 'NONE' NOT NULL,
	"system_category_confidence" numeric(5, 4),
	"system_merchant_source" text DEFAULT 'NONE' NOT NULL,
	"system_merchant_confidence" numeric(5, 4),
	"system_financial_role_source" text DEFAULT 'NONE' NOT NULL,
	"system_financial_role_confidence" numeric(5, 4),
	"system_exclusion_source" text DEFAULT 'NONE' NOT NULL,
	"installment_number" integer,
	"installment_total" integer,
	"installment_total_amount" numeric(20, 6),
	"payee_mcc" text,
	"card_last_four" text,
	"provider_bill_id" text,
	"credit_card_bill_id" uuid,
	"bill_forecast_month" date,
	"fee_type" text,
	"fee_type_additional_info" text,
	"other_credits_type" text,
	"other_credits_additional_info" text,
	"installment_series_id" uuid,
	"recurring_series_id" uuid,
	"transfer_pair_id" uuid,
	"duplicate_review_status" text DEFAULT 'NONE' NOT NULL,
	"dedupe_fingerprint" char(64) NOT NULL,
	"latest_raw_object_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "financial_transaction_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "financial_transaction_provider_ck" CHECK ("financial_transaction"."provider" = 'PLUGGY'),
	CONSTRAINT "financial_transaction_provider_transaction_id_nonempty_ck" CHECK ("financial_transaction"."provider_transaction_id" is null or length(trim("financial_transaction"."provider_transaction_id")) > 0),
	CONSTRAINT "financial_transaction_status_ck" CHECK ("financial_transaction"."status" in ('PENDING', 'POSTED', 'DELETED', 'UNKNOWN')),
	CONSTRAINT "financial_transaction_provider_type_ck" CHECK ("financial_transaction"."provider_type" is null or "financial_transaction"."provider_type" in ('DEBIT', 'CREDIT')),
	CONSTRAINT "financial_transaction_currency_ck" CHECK ("financial_transaction"."provider_currency" ~ '^[A-Z]{3}$' and "financial_transaction"."account_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "financial_transaction_system_direction_ck" CHECK ("financial_transaction"."system_direction" in ('INFLOW', 'OUTFLOW', 'NEUTRAL', 'UNKNOWN')),
	CONSTRAINT "financial_transaction_system_financial_role_ck" CHECK ("financial_transaction"."system_financial_role" in ('PURCHASE', 'INCOME', 'TRANSFER', 'CARD_BILL_PAYMENT', 'REFUND', 'FEE', 'TAX', 'CASH_WITHDRAWAL', 'ADJUSTMENT', 'INVESTMENT_MOVEMENT', 'CREDIT', 'UNKNOWN_CREDIT', 'UNKNOWN')),
	CONSTRAINT "financial_transaction_category_source_ck" CHECK ("financial_transaction"."system_category_source" in ('RULE', 'MERCHANT', 'HEURISTIC', 'PROVIDER', 'MODEL', 'NONE')),
	CONSTRAINT "financial_transaction_merchant_source_ck" CHECK ("financial_transaction"."system_merchant_source" in ('RULE', 'MERCHANT', 'HEURISTIC', 'PROVIDER', 'MODEL', 'NONE')),
	CONSTRAINT "financial_transaction_role_source_ck" CHECK ("financial_transaction"."system_financial_role_source" in ('RULE', 'HEURISTIC', 'PROVIDER', 'MODEL', 'NONE')),
	CONSTRAINT "financial_transaction_exclusion_source_nonempty_ck" CHECK (length(trim("financial_transaction"."system_exclusion_source")) > 0),
	CONSTRAINT "financial_transaction_confidence_ck" CHECK (("financial_transaction"."system_category_confidence" is null or "financial_transaction"."system_category_confidence" between 0 and 1) and ("financial_transaction"."system_merchant_confidence" is null or "financial_transaction"."system_merchant_confidence" between 0 and 1) and ("financial_transaction"."system_financial_role_confidence" is null or "financial_transaction"."system_financial_role_confidence" between 0 and 1)),
	CONSTRAINT "financial_transaction_installment_ck" CHECK (("financial_transaction"."installment_number" is null and "financial_transaction"."installment_total" is null) or ("financial_transaction"."installment_number" between 1 and "financial_transaction"."installment_total" and "financial_transaction"."installment_total" > 0)),
	CONSTRAINT "financial_transaction_card_last_four_ck" CHECK ("financial_transaction"."card_last_four" is null or "financial_transaction"."card_last_four" ~ '^[0-9]{4}$'),
	CONSTRAINT "financial_transaction_bill_forecast_month_ck" CHECK ("financial_transaction"."bill_forecast_month" is null or "financial_transaction"."bill_forecast_month" = date_trunc('month', "financial_transaction"."bill_forecast_month")::date),
	CONSTRAINT "financial_transaction_duplicate_review_status_ck" CHECK ("financial_transaction"."duplicate_review_status" in ('NONE', 'POSSIBLE', 'CONFIRMED_DUPLICATE', 'CONFIRMED_DISTINCT')),
	CONSTRAINT "financial_transaction_dedupe_fingerprint_ck" CHECK ("financial_transaction"."dedupe_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "financial_transaction_transfer_pair_not_self_ck" CHECK ("financial_transaction"."transfer_pair_id" is null or "financial_transaction"."transfer_pair_id" <> "financial_transaction"."id"),
	CONSTRAINT "financial_transaction_future_series_unset_ck" CHECK ("financial_transaction"."installment_series_id" is null and "financial_transaction"."recurring_series_id" is null),
	CONSTRAINT "financial_transaction_bounded_text_ck" CHECK (length("financial_transaction"."description_original") between 1 and 1000 and length("financial_transaction"."description_normalized") between 1 and 1000 and ("financial_transaction"."provider_operation_type_additional_info" is null or length("financial_transaction"."provider_operation_type_additional_info") <= 1000) and ("financial_transaction"."fee_type_additional_info" is null or length("financial_transaction"."fee_type_additional_info") <= 1000) and ("financial_transaction"."other_credits_additional_info" is null or length("financial_transaction"."other_credits_additional_info") <= 1000))
);
--> statement-breakpoint
CREATE TABLE "merchant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_key" text NOT NULL,
	"merchant_group" text,
	"mcc" text,
	"cnpj_hash" char(64),
	"default_category_id" uuid,
	"review_status" text DEFAULT 'NEEDS_REVIEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "merchant_workspace_normalized_key_uq" UNIQUE("workspace_id","normalized_key"),
	CONSTRAINT "merchant_canonical_name_nonempty_ck" CHECK (length(trim("merchant"."canonical_name")) > 0),
	CONSTRAINT "merchant_normalized_key_nonempty_ck" CHECK (length(trim("merchant"."normalized_key")) > 0),
	CONSTRAINT "merchant_cnpj_hash_ck" CHECK ("merchant"."cnpj_hash" is null or "merchant"."cnpj_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "merchant_review_status_ck" CHECK ("merchant"."review_status" in ('AUTO', 'CONFIRMED', 'NEEDS_REVIEW'))
);
--> statement-breakpoint
CREATE TABLE "merchant_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"alias_normalized" text NOT NULL,
	"match_type" text NOT NULL,
	"source" text NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_alias_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "merchant_alias_workspace_alias_normalized_uq" UNIQUE("workspace_id","alias_normalized"),
	CONSTRAINT "merchant_alias_alias_normalized_nonempty_ck" CHECK (length(trim("merchant_alias"."alias_normalized")) > 0),
	CONSTRAINT "merchant_alias_match_type_ck" CHECK ("merchant_alias"."match_type" in ('EXACT', 'PREFIX', 'CONTAINS', 'REGEX')),
	CONSTRAINT "merchant_alias_source_ck" CHECK ("merchant_alias"."source" in ('USER', 'PROVIDER', 'HEURISTIC', 'IMPORT')),
	CONSTRAINT "merchant_alias_confidence_ck" CHECK ("merchant_alias"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "transaction_identity_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"predecessor_transaction_id" uuid NOT NULL,
	"successor_transaction_id" uuid NOT NULL,
	"link_type" text DEFAULT 'PROVIDER_REPLACEMENT' NOT NULL,
	"status" text DEFAULT 'NEEDS_REVIEW' NOT NULL,
	"confidence" numeric(5, 4),
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	CONSTRAINT "transaction_identity_link_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "transaction_identity_link_candidate_uq" UNIQUE("workspace_id","predecessor_transaction_id","successor_transaction_id","link_type"),
	CONSTRAINT "transaction_identity_link_not_self_ck" CHECK ("transaction_identity_link"."predecessor_transaction_id" <> "transaction_identity_link"."successor_transaction_id"),
	CONSTRAINT "transaction_identity_link_type_ck" CHECK ("transaction_identity_link"."link_type" = 'PROVIDER_REPLACEMENT'),
	CONSTRAINT "transaction_identity_link_status_ck" CHECK ("transaction_identity_link"."status" in ('AUTO_CONFIRMED', 'NEEDS_REVIEW', 'USER_CONFIRMED', 'REJECTED')),
	CONSTRAINT "transaction_identity_link_confidence_ck" CHECK ("transaction_identity_link"."confidence" is null or "transaction_identity_link"."confidence" between 0 and 1),
	CONSTRAINT "transaction_identity_link_confirmation_ck" CHECK ("transaction_identity_link"."status" not in ('AUTO_CONFIRMED', 'USER_CONFIRMED') or "transaction_identity_link"."confirmed_at" is not null),
	CONSTRAINT "transaction_identity_link_evidence_length_ck" CHECK (octet_length("transaction_identity_link"."evidence"::text) <= 10000)
);
--> statement-breakpoint
CREATE TABLE "transaction_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"financial_transaction_id" uuid NOT NULL,
	"change_type" text NOT NULL,
	"changed_fields" jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_revision_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "transaction_revision_change_type_ck" CHECK ("transaction_revision"."change_type" in ('PROVIDER_UPDATE', 'MANUAL_EDIT', 'CLASSIFICATION', 'MERGE', 'DELETE')),
	CONSTRAINT "transaction_revision_actor_type_ck" CHECK ("transaction_revision"."actor_type" in ('USER', 'WORKER', 'SYSTEM', 'MCP')),
	CONSTRAINT "transaction_revision_changed_fields_length_ck" CHECK (octet_length("transaction_revision"."changed_fields"::text) <= 20000)
);
--> statement-breakpoint
CREATE TABLE "transaction_user_state" (
	"financial_transaction_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"category_override_enabled" boolean DEFAULT false NOT NULL,
	"category_id_override" uuid,
	"merchant_override_enabled" boolean DEFAULT false NOT NULL,
	"merchant_id_override" uuid,
	"financial_role_override_enabled" boolean DEFAULT false NOT NULL,
	"financial_role_override" text,
	"excluded_from_spend_override" boolean,
	"notes" text,
	"review_status" text DEFAULT 'UNREVIEWED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_actor_type" text NOT NULL,
	"updated_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_user_state_financial_role_override_ck" CHECK (("transaction_user_state"."financial_role_override_enabled" and "transaction_user_state"."financial_role_override" in ('PURCHASE', 'INCOME', 'TRANSFER', 'CARD_BILL_PAYMENT', 'REFUND', 'FEE', 'TAX', 'CASH_WITHDRAWAL', 'ADJUSTMENT', 'INVESTMENT_MOVEMENT', 'CREDIT', 'UNKNOWN_CREDIT', 'UNKNOWN')) or (not "transaction_user_state"."financial_role_override_enabled" and "transaction_user_state"."financial_role_override" is null)),
	CONSTRAINT "transaction_user_state_category_override_ck" CHECK ("transaction_user_state"."category_override_enabled" or "transaction_user_state"."category_id_override" is null),
	CONSTRAINT "transaction_user_state_merchant_override_ck" CHECK ("transaction_user_state"."merchant_override_enabled" or "transaction_user_state"."merchant_id_override" is null),
	CONSTRAINT "transaction_user_state_review_status_ck" CHECK ("transaction_user_state"."review_status" in ('UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'IGNORED')),
	CONSTRAINT "transaction_user_state_version_ck" CHECK ("transaction_user_state"."version" > 0),
	CONSTRAINT "transaction_user_state_actor_type_ck" CHECK ("transaction_user_state"."updated_by_actor_type" in ('USER', 'SYSTEM', 'MIGRATION')),
	CONSTRAINT "transaction_user_state_notes_length_ck" CHECK ("transaction_user_state"."notes" is null or length("transaction_user_state"."notes") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "bill_payment_reconciliation" ADD CONSTRAINT "bill_payment_reconciliation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "bill_payment_reconciliation" ADD CONSTRAINT "bill_payment_reconciliation_workspace_payment_fk" FOREIGN KEY ("workspace_id","credit_card_bill_payment_id") REFERENCES "public"."credit_card_bill_payment"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "bill_payment_reconciliation" ADD CONSTRAINT "bill_payment_reconciliation_workspace_transaction_fk" FOREIGN KEY ("workspace_id","financial_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill" ADD CONSTRAINT "credit_card_bill_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill" ADD CONSTRAINT "credit_card_bill_workspace_financial_account_fk" FOREIGN KEY ("workspace_id","financial_account_id") REFERENCES "public"."financial_account"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill" ADD CONSTRAINT "credit_card_bill_workspace_latest_raw_object_fk" FOREIGN KEY ("workspace_id","latest_raw_object_id") REFERENCES "public"."provider_raw_object"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_finance_charge" ADD CONSTRAINT "credit_card_bill_finance_charge_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_finance_charge" ADD CONSTRAINT "credit_card_bill_finance_charge_workspace_bill_fk" FOREIGN KEY ("workspace_id","credit_card_bill_id") REFERENCES "public"."credit_card_bill"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_finance_charge" ADD CONSTRAINT "credit_card_bill_finance_charge_workspace_matched_transaction_fk" FOREIGN KEY ("workspace_id","matched_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_finance_charge" ADD CONSTRAINT "credit_card_bill_finance_charge_workspace_latest_raw_object_fk" FOREIGN KEY ("workspace_id","latest_raw_object_id") REFERENCES "public"."provider_raw_object"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_payment" ADD CONSTRAINT "credit_card_bill_payment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_payment" ADD CONSTRAINT "credit_card_bill_payment_workspace_bill_fk" FOREIGN KEY ("workspace_id","credit_card_bill_id") REFERENCES "public"."credit_card_bill"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_payment" ADD CONSTRAINT "credit_card_bill_payment_workspace_matched_card_transaction_fk" FOREIGN KEY ("workspace_id","matched_card_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "credit_card_bill_payment" ADD CONSTRAINT "credit_card_bill_payment_workspace_latest_raw_object_fk" FOREIGN KEY ("workspace_id","latest_raw_object_id") REFERENCES "public"."provider_raw_object"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_workspace_provider_connection_fk" FOREIGN KEY ("workspace_id","provider_connection_id") REFERENCES "public"."provider_connection"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_account" ADD CONSTRAINT "financial_account_workspace_latest_raw_object_fk" FOREIGN KEY ("workspace_id","latest_raw_object_id") REFERENCES "public"."provider_raw_object"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_system_category_id_category_id_fk" FOREIGN KEY ("system_category_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_financial_account_fk" FOREIGN KEY ("workspace_id","financial_account_id") REFERENCES "public"."financial_account"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_system_merchant_fk" FOREIGN KEY ("workspace_id","system_merchant_id") REFERENCES "public"."merchant"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_credit_card_bill_fk" FOREIGN KEY ("workspace_id","credit_card_bill_id") REFERENCES "public"."credit_card_bill"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_transfer_pair_fk" FOREIGN KEY ("workspace_id","transfer_pair_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_transaction" ADD CONSTRAINT "financial_transaction_workspace_latest_raw_object_fk" FOREIGN KEY ("workspace_id","latest_raw_object_id") REFERENCES "public"."provider_raw_object"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "merchant" ADD CONSTRAINT "merchant_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "merchant" ADD CONSTRAINT "merchant_default_category_id_category_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "merchant_alias" ADD CONSTRAINT "merchant_alias_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "merchant_alias" ADD CONSTRAINT "merchant_alias_workspace_merchant_fk" FOREIGN KEY ("workspace_id","merchant_id") REFERENCES "public"."merchant"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_identity_link" ADD CONSTRAINT "transaction_identity_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_identity_link" ADD CONSTRAINT "transaction_identity_link_workspace_predecessor_fk" FOREIGN KEY ("workspace_id","predecessor_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_identity_link" ADD CONSTRAINT "transaction_identity_link_workspace_successor_fk" FOREIGN KEY ("workspace_id","successor_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_revision" ADD CONSTRAINT "transaction_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_revision" ADD CONSTRAINT "transaction_revision_workspace_financial_transaction_fk" FOREIGN KEY ("workspace_id","financial_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_user_state" ADD CONSTRAINT "transaction_user_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_user_state" ADD CONSTRAINT "transaction_user_state_category_id_override_category_id_fk" FOREIGN KEY ("category_id_override") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_user_state" ADD CONSTRAINT "transaction_user_state_workspace_financial_transaction_fk" FOREIGN KEY ("workspace_id","financial_transaction_id") REFERENCES "public"."financial_transaction"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "transaction_user_state" ADD CONSTRAINT "transaction_user_state_workspace_merchant_override_fk" FOREIGN KEY ("workspace_id","merchant_id_override") REFERENCES "public"."merchant"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_payment_reconciliation_active_payment_uq" ON "bill_payment_reconciliation" USING btree ("workspace_id","credit_card_bill_payment_id") WHERE "bill_payment_reconciliation"."match_status" in ('AUTO_MATCHED', 'USER_CONFIRMED');--> statement-breakpoint
CREATE UNIQUE INDEX "category_builtin_code_uq" ON "category" USING btree ("code") WHERE "category"."workspace_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "category_workspace_code_uq" ON "category" USING btree ("workspace_id","code") WHERE "category"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_transaction_provider_identity_uq" ON "financial_transaction" USING btree ("workspace_id","provider","provider_transaction_id") WHERE "financial_transaction"."provider_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "financial_transaction_workspace_local_date_idx" ON "financial_transaction" USING btree ("workspace_id","transaction_local_date" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "financial_transaction_workspace_category_date_idx" ON "financial_transaction" USING btree ("workspace_id","system_category_id","transaction_local_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "financial_transaction_workspace_merchant_date_idx" ON "financial_transaction" USING btree ("workspace_id","system_merchant_id","transaction_local_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "financial_transaction_workspace_account_date_idx" ON "financial_transaction" USING btree ("workspace_id","financial_account_id","transaction_local_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "financial_transaction_dedupe_fingerprint_idx" ON "financial_transaction" USING btree ("dedupe_fingerprint");--> statement-breakpoint
CREATE INDEX "financial_transaction_workspace_status_active_idx" ON "financial_transaction" USING btree ("workspace_id","status") WHERE "financial_transaction"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_identity_link_active_predecessor_uq" ON "transaction_identity_link" USING btree ("workspace_id","predecessor_transaction_id") WHERE "transaction_identity_link"."status" in ('AUTO_CONFIRMED', 'USER_CONFIRMED');--> statement-breakpoint
CREATE INDEX "transaction_revision_transaction_created_idx" ON "transaction_revision" USING btree ("financial_transaction_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE FUNCTION cashcount_validate_category_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_workspace_id uuid;
BEGIN
	IF TG_OP = 'UPDATE'
		AND (
			NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
			OR NEW.code IS DISTINCT FROM OLD.code
		)
	THEN
		RAISE EXCEPTION 'category workspace and code are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF NEW.parent_id IS NOT NULL THEN
		SELECT workspace_id
		INTO parent_workspace_id
		FROM category
		WHERE id = NEW.parent_id;

		IF FOUND AND (
			(NEW.workspace_id IS NULL AND parent_workspace_id IS NOT NULL)
			OR (
				NEW.workspace_id IS NOT NULL
				AND parent_workspace_id IS NOT NULL
				AND parent_workspace_id <> NEW.workspace_id
			)
		) THEN
			RAISE EXCEPTION 'category parent is not visible in the category workspace'
				USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER category_scope_validate_trg
BEFORE INSERT OR UPDATE OF workspace_id, code, parent_id
ON category
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_category_row();
--> statement-breakpoint
CREATE FUNCTION cashcount_validate_category_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	category_reference_id uuid;
	reference_workspace_id uuid;
BEGIN
	category_reference_id := nullif(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
	reference_workspace_id := nullif(to_jsonb(NEW) ->> 'workspace_id', '')::uuid;

	IF category_reference_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM category
			WHERE id = category_reference_id
				AND (workspace_id IS NULL OR workspace_id = reference_workspace_id)
		)
	THEN
		RAISE EXCEPTION 'category reference is not visible in the row workspace'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER merchant_category_visibility_trg
BEFORE INSERT OR UPDATE OF workspace_id, default_category_id
ON merchant
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_category_reference('default_category_id');
--> statement-breakpoint
CREATE TRIGGER financial_transaction_category_visibility_trg
BEFORE INSERT OR UPDATE OF workspace_id, system_category_id
ON financial_transaction
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_category_reference('system_category_id');
--> statement-breakpoint
CREATE TRIGGER transaction_user_state_category_visibility_trg
BEFORE INSERT OR UPDATE OF workspace_id, category_id_override
ON transaction_user_state
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_category_reference('category_id_override');
--> statement-breakpoint
CREATE FUNCTION cashcount_validate_credit_card_bill_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM financial_account
		WHERE workspace_id = NEW.workspace_id
			AND id = NEW.financial_account_id
			AND account_type = 'CREDIT_CARD'
	) THEN
		RAISE EXCEPTION 'credit-card bill must reference a credit-card account in its workspace'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_card_bill_account_type_trg
BEFORE INSERT OR UPDATE OF workspace_id, financial_account_id
ON credit_card_bill
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_credit_card_bill_account();
--> statement-breakpoint
CREATE FUNCTION cashcount_validate_transaction_bill_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.credit_card_bill_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1
			FROM credit_card_bill
			WHERE workspace_id = NEW.workspace_id
				AND id = NEW.credit_card_bill_id
				AND financial_account_id = NEW.financial_account_id
		)
	THEN
		RAISE EXCEPTION 'transaction bill must belong to the transaction account'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER financial_transaction_bill_account_trg
BEFORE INSERT OR UPDATE OF workspace_id, financial_account_id, credit_card_bill_id
ON financial_transaction
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_transaction_bill_account();
--> statement-breakpoint
CREATE FUNCTION cashcount_validate_matched_transaction_account_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	account_type_value text;
	matched_transaction_id uuid;
BEGIN
	matched_transaction_id := nullif(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;

	IF matched_transaction_id IS NULL THEN
		RETURN NEW;
	END IF;

	SELECT account.account_type
	INTO account_type_value
	FROM financial_transaction AS financial_transaction_row
	JOIN financial_account AS account
		ON account.workspace_id = financial_transaction_row.workspace_id
		AND account.id = financial_transaction_row.financial_account_id
	WHERE financial_transaction_row.workspace_id = NEW.workspace_id
		AND financial_transaction_row.id = matched_transaction_id;

	IF FOUND AND (
		(TG_ARGV[1] = 'CREDIT_CARD' AND account_type_value <> 'CREDIT_CARD')
		OR (
			TG_ARGV[1] = 'DEPOSIT'
			AND account_type_value NOT IN ('CHECKING', 'SAVINGS')
		)
	) THEN
		RAISE EXCEPTION 'matched transaction has an incompatible account type'
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credit_card_bill_payment_matched_transaction_trg
BEFORE INSERT OR UPDATE OF workspace_id, matched_card_transaction_id
ON credit_card_bill_payment
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_matched_transaction_account_type(
	'matched_card_transaction_id',
	'CREDIT_CARD'
);
--> statement-breakpoint
CREATE TRIGGER credit_card_bill_finance_charge_matched_transaction_trg
BEFORE INSERT OR UPDATE OF workspace_id, matched_transaction_id
ON credit_card_bill_finance_charge
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_matched_transaction_account_type(
	'matched_transaction_id',
	'CREDIT_CARD'
);
--> statement-breakpoint
CREATE TRIGGER bill_payment_reconciliation_matched_transaction_trg
BEFORE INSERT OR UPDATE OF workspace_id, financial_transaction_id
ON bill_payment_reconciliation
FOR EACH ROW
EXECUTE FUNCTION cashcount_validate_matched_transaction_account_type(
	'financial_transaction_id',
	'DEPOSIT'
);
