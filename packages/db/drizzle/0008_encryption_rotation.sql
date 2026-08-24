CREATE TABLE "encryption_rotation_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_key_version" integer NOT NULL,
	"to_key_version" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"current_table" text,
	"last_processed_id" uuid,
	"rows_examined" bigint DEFAULT 0 NOT NULL,
	"rows_reencrypted" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encryption_rotation_run_from_key_version_ck" CHECK ("encryption_rotation_run"."from_key_version" > 0),
	CONSTRAINT "encryption_rotation_run_to_key_version_ck" CHECK ("encryption_rotation_run"."to_key_version" > 0),
	CONSTRAINT "encryption_rotation_run_distinct_versions_ck" CHECK ("encryption_rotation_run"."from_key_version" <> "encryption_rotation_run"."to_key_version"),
	CONSTRAINT "encryption_rotation_run_status_ck" CHECK ("encryption_rotation_run"."status" in ('PENDING', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "encryption_rotation_run_current_table_ck" CHECK ("encryption_rotation_run"."current_table" is null or "encryption_rotation_run"."current_table" in ('provider_raw_object', 'webhook_event')),
	CONSTRAINT "encryption_rotation_run_progress_ck" CHECK ("encryption_rotation_run"."rows_examined" >= 0 and "encryption_rotation_run"."rows_reencrypted" >= 0 and "encryption_rotation_run"."rows_reencrypted" <= "encryption_rotation_run"."rows_examined"),
	CONSTRAINT "encryption_rotation_run_last_error_summary_length_ck" CHECK ("encryption_rotation_run"."last_error_summary" is null or length("encryption_rotation_run"."last_error_summary") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "provider_raw_object" DROP CONSTRAINT "provider_raw_object_envelope_nonempty_ck";--> statement-breakpoint
ALTER TABLE "webhook_event" DROP CONSTRAINT "webhook_event_envelope_nonempty_ck";--> statement-breakpoint
ALTER TABLE "provider_raw_object" ADD COLUMN "canonicalization_version" text DEFAULT 'CASHCOUNT_JSON_V1' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD COLUMN "canonicalization_version" text DEFAULT 'CASHCOUNT_JSON_V1' NOT NULL;--> statement-breakpoint
CREATE INDEX "encryption_rotation_run_status_created_idx" ON "encryption_rotation_run" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "provider_raw_object" ADD CONSTRAINT "provider_raw_object_canonicalization_version_ck" CHECK (length(trim("provider_raw_object"."canonicalization_version")) between 1 and 100);--> statement-breakpoint
ALTER TABLE "provider_raw_object" ADD CONSTRAINT "provider_raw_object_envelope_nonempty_ck" CHECK (octet_length("provider_raw_object"."payload_ciphertext") > 0 and octet_length("provider_raw_object"."payload_iv") = 12 and octet_length("provider_raw_object"."payload_tag") = 16);--> statement-breakpoint
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_canonicalization_version_ck" CHECK (length(trim("webhook_event"."canonicalization_version")) between 1 and 100);--> statement-breakpoint
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_envelope_nonempty_ck" CHECK (octet_length("webhook_event"."payload_ciphertext") > 0 and octet_length("webhook_event"."payload_iv") = 12 and octet_length("webhook_event"."payload_tag") = 16);
