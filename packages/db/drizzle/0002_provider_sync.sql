CREATE TABLE "job_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"job_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"last_error_code" text,
	"last_error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_queue_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "job_queue_job_type_nonempty_ck" CHECK (length(trim("job_queue"."job_type")) > 0),
	CONSTRAINT "job_queue_dedupe_key_nonempty_ck" CHECK ("job_queue"."dedupe_key" is null or length(trim("job_queue"."dedupe_key")) > 0),
	CONSTRAINT "job_queue_status_ck" CHECK ("job_queue"."status" in ('PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY', 'DEAD')),
	CONSTRAINT "job_queue_attempt_count_ck" CHECK ("job_queue"."attempt_count" >= 0),
	CONSTRAINT "job_queue_max_attempts_ck" CHECK ("job_queue"."max_attempts" > 0),
	CONSTRAINT "job_queue_attempt_limit_ck" CHECK ("job_queue"."attempt_count" <= "job_queue"."max_attempts"),
	CONSTRAINT "job_queue_running_lease_ck" CHECK ("job_queue"."status" <> 'RUNNING' or ("job_queue"."locked_at" is not null and "job_queue"."locked_by" is not null and length(trim("job_queue"."locked_by")) > 0 and "job_queue"."started_at" is not null and "job_queue"."heartbeat_at" is not null and "job_queue"."lease_expires_at" is not null)),
	CONSTRAINT "job_queue_terminal_finished_at_ck" CHECK ("job_queue"."status" not in ('SUCCEEDED', 'DEAD') or "job_queue"."finished_at" is not null),
	CONSTRAINT "job_queue_last_error_summary_length_ck" CHECK ("job_queue"."last_error_summary" is null or length("job_queue"."last_error_summary") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "provider_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_connection_id" text NOT NULL,
	"external_connector_id" text NOT NULL,
	"display_name" text NOT NULL,
	"local_status" text DEFAULT 'ACTIVE' NOT NULL,
	"provider_item_status" text,
	"provider_execution_status" text,
	"action_required_at" timestamp with time zone,
	"consent_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"last_provider_update_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "provider_connection_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "provider_connection_external_identity_uq" UNIQUE("workspace_id","provider","external_connection_id"),
	CONSTRAINT "provider_connection_provider_ck" CHECK ("provider_connection"."provider" = 'PLUGGY'),
	CONSTRAINT "provider_connection_external_connection_id_nonempty_ck" CHECK (length(trim("provider_connection"."external_connection_id")) > 0),
	CONSTRAINT "provider_connection_external_connector_id_nonempty_ck" CHECK (length(trim("provider_connection"."external_connector_id")) > 0),
	CONSTRAINT "provider_connection_display_name_nonempty_ck" CHECK (length(trim("provider_connection"."display_name")) > 0),
	CONSTRAINT "provider_connection_local_status_ck" CHECK ("provider_connection"."local_status" in ('ACTIVE', 'SYNCING', 'USER_INPUT_REQUIRED', 'USER_ACTION_REQUIRED', 'REAUTH_REQUIRED', 'PROVIDER_ERROR', 'DELETED', 'DISABLED')),
	CONSTRAINT "provider_connection_last_error_summary_length_ck" CHECK ("provider_connection"."last_error_summary" is null or length("provider_connection"."last_error_summary") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "provider_raw_object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"payload_ciphertext" "bytea" NOT NULL,
	"payload_iv" "bytea" NOT NULL,
	"payload_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"source_event_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone,
	CONSTRAINT "provider_raw_object_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "provider_raw_object_provider_ck" CHECK ("provider_raw_object"."provider" = 'PLUGGY'),
	CONSTRAINT "provider_raw_object_entity_type_nonempty_ck" CHECK (length(trim("provider_raw_object"."entity_type")) > 0),
	CONSTRAINT "provider_raw_object_external_id_nonempty_ck" CHECK (length(trim("provider_raw_object"."external_id")) > 0),
	CONSTRAINT "provider_raw_object_envelope_nonempty_ck" CHECK (octet_length("provider_raw_object"."payload_ciphertext") > 0 and octet_length("provider_raw_object"."payload_iv") > 0 and octet_length("provider_raw_object"."payload_tag") > 0),
	CONSTRAINT "provider_raw_object_key_version_ck" CHECK ("provider_raw_object"."key_version" > 0),
	CONSTRAINT "provider_raw_object_payload_sha256_ck" CHECK ("provider_raw_object"."payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_connection_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"accounts_seen" integer DEFAULT 0 NOT NULL,
	"transactions_seen" integer DEFAULT 0 NOT NULL,
	"transactions_inserted" integer DEFAULT 0 NOT NULL,
	"transactions_updated" integer DEFAULT 0 NOT NULL,
	"transactions_deleted" integer DEFAULT 0 NOT NULL,
	"bills_seen" integer DEFAULT 0 NOT NULL,
	"cursor_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_summary" text,
	CONSTRAINT "sync_run_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "sync_run_trigger_type_ck" CHECK ("sync_run"."trigger_type" in ('INITIAL', 'WEBHOOK', 'MANUAL', 'SCHEDULED', 'RECOVERY')),
	CONSTRAINT "sync_run_status_ck" CHECK ("sync_run"."status" in ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')),
	CONSTRAINT "sync_run_finished_at_ck" CHECK (("sync_run"."status" = 'RUNNING' and "sync_run"."finished_at" is null) or ("sync_run"."status" <> 'RUNNING' and "sync_run"."finished_at" is not null)),
	CONSTRAINT "sync_run_counters_ck" CHECK ("sync_run"."accounts_seen" >= 0 and "sync_run"."transactions_seen" >= 0 and "sync_run"."transactions_inserted" >= 0 and "sync_run"."transactions_updated" >= 0 and "sync_run"."transactions_deleted" >= 0 and "sync_run"."bills_seen" >= 0),
	CONSTRAINT "sync_run_error_summary_length_ck" CHECK ("sync_run"."error_summary" is null or length("sync_run"."error_summary") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"external_connection_id" text,
	"external_account_id" text,
	"payload_ciphertext" "bytea" NOT NULL,
	"payload_iv" "bytea" NOT NULL,
	"payload_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"processed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_summary" text,
	CONSTRAINT "webhook_event_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhook_event_provider_ck" CHECK ("webhook_event"."provider" = 'PLUGGY'),
	CONSTRAINT "webhook_event_external_event_id_nonempty_ck" CHECK (length(trim("webhook_event"."external_event_id")) > 0),
	CONSTRAINT "webhook_event_event_type_nonempty_ck" CHECK (length(trim("webhook_event"."event_type")) > 0),
	CONSTRAINT "webhook_event_envelope_nonempty_ck" CHECK (octet_length("webhook_event"."payload_ciphertext") > 0 and octet_length("webhook_event"."payload_iv") > 0 and octet_length("webhook_event"."payload_tag") > 0),
	CONSTRAINT "webhook_event_key_version_ck" CHECK ("webhook_event"."key_version" > 0),
	CONSTRAINT "webhook_event_payload_sha256_ck" CHECK ("webhook_event"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "webhook_event_workspace_scope_ck" CHECK (("webhook_event"."workspace_id" is null and "webhook_event"."status" = 'UNMAPPED') or "webhook_event"."workspace_id" is not null),
	CONSTRAINT "webhook_event_status_ck" CHECK ("webhook_event"."status" in ('RECEIVED', 'QUEUED', 'PROCESSED', 'FAILED', 'IGNORED', 'UNMAPPED')),
	CONSTRAINT "webhook_event_attempt_count_ck" CHECK ("webhook_event"."attempt_count" >= 0),
	CONSTRAINT "webhook_event_last_error_summary_length_ck" CHECK ("webhook_event"."last_error_summary" is null or length("webhook_event"."last_error_summary") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "provider_connection" ADD CONSTRAINT "provider_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "provider_raw_object" ADD CONSTRAINT "provider_raw_object_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_workspace_provider_connection_fk" FOREIGN KEY ("workspace_id","provider_connection_id") REFERENCES "public"."provider_connection"("workspace_id","id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "job_queue_claim_idx" ON "job_queue" USING btree ("status","available_at","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "job_queue_active_dedupe_uq" ON "job_queue" USING btree (coalesce("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),"job_type","dedupe_key") WHERE "job_queue"."dedupe_key" is not null and "job_queue"."status" in ('PENDING', 'RETRY', 'RUNNING');--> statement-breakpoint
CREATE INDEX "provider_raw_object_identity_observed_idx" ON "provider_raw_object" USING btree ("workspace_id","provider","entity_type","external_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_run_provider_connection_started_idx" ON "sync_run" USING btree ("provider_connection_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_external_identity_uq" ON "webhook_event" USING btree (coalesce("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),"provider","external_event_id");