CREATE EXTENSION IF NOT EXISTS "citext";
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text,
	"auth_provider" text NOT NULL,
	"auth_subject" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_uq" UNIQUE("email"),
	CONSTRAINT "app_user_auth_identity_uq" UNIQUE("auth_provider","auth_subject"),
	CONSTRAINT "app_user_email_nonempty_ck" CHECK (length(trim("app_user"."email"::text)) > 0),
	CONSTRAINT "app_user_email_normalized_ck" CHECK ("app_user"."email"::text = lower("app_user"."email"::text)),
	CONSTRAINT "app_user_display_name_nonempty_ck" CHECK ("app_user"."display_name" is null or length(trim("app_user"."display_name")) > 0),
	CONSTRAINT "app_user_auth_provider_nonempty_ck" CHECK (length(trim("app_user"."auth_provider")) > 0),
	CONSTRAINT "app_user_auth_subject_nonempty_ck" CHECK (length(trim("app_user"."auth_subject")) > 0),
	CONSTRAINT "app_user_status_ck" CHECK ("app_user"."status" in ('ACTIVE', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"base_currency" char(3) DEFAULT 'BRL' NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"analytics_policy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_name_nonempty_ck" CHECK (length(trim("workspace"."name")) > 0),
	CONSTRAINT "workspace_base_currency_ck" CHECK ("workspace"."base_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "workspace_timezone_nonempty_ck" CHECK (length(trim("workspace"."timezone")) > 0),
	CONSTRAINT "workspace_analytics_policy_version_ck" CHECK ("workspace"."analytics_policy_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'OWNER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_member_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_member_role_ck" CHECK ("workspace_member"."role" = 'OWNER')
);
--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "workspace_member_user_id_idx" ON "workspace_member" USING btree ("user_id");
