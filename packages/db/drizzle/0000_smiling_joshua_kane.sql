CREATE TYPE "public"."approval_action" AS ENUM('approved', 'edited', 'rejected', 'commented');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('whatsapp', 'gmail', 'telegram', 'phone', 'teams');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('text', 'audio', 'image', 'video', 'file', 'email_body', 'call', 'meeting');--> statement-breakpoint
CREATE TYPE "public"."cost_service" AS ENUM('anthropic', 'openai_whisper', 'assemblyai', 'r2', 'other');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('android', 'ios', 'web');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('inbound', 'outbound', 'internal');--> statement-breakpoint
CREATE TYPE "public"."identifier_kind" AS ENUM('phone', 'email', 'whatsapp_wa_id', 'telegram_user_id', 'teams_user_id');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('proposal', 'pending_identifier', 'session_error', 'cost_warn', 'cost_exceeded', 'injaz_sync_fail', 'digest');--> statement-breakpoint
CREATE TYPE "public"."pending_identifier_state" AS ENUM('pending', 'linked', 'new_contact_created', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'med', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."proposed_task_state" AS ENUM('proposed', 'approved', 'edited', 'rejected', 'synced');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('open', 'aggregating', 'reasoning', 'awaiting_approval', 'approved', 'rejected', 'synced', 'closed', 'error');--> statement-breakpoint
CREATE TYPE "public"."session_trigger" AS ENUM('silence_timeout', 'manual', 'cron', 'command');--> statement-breakpoint
CREATE TYPE "public"."sync_state" AS ENUM('pending', 'synced', 'drift', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."transcript_provider" AS ENUM('whisper', 'assemblyai');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'approver', 'viewer');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" "identifier_kind" NOT NULL,
	"value" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_identifiers_kind_value_uq" UNIQUE("kind","value")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"account_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "identifier_kind" NOT NULL,
	"value" text NOT NULL,
	"first_seen_interaction_id" uuid,
	"suggested_contact_id" uuid,
	"suggestion_confidence" numeric(4, 3),
	"state" "pending_identifier_state" DEFAULT 'pending' NOT NULL,
	"telegram_message_id" text,
	"notification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"drive_url" text,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"contact_id" uuid,
	"channel" "channel" NOT NULL,
	"direction" "direction" NOT NULL,
	"content_type" "content_type" NOT NULL,
	"text" text,
	"raw_payload" jsonb,
	"source_message_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interactions_channel_msg_uq" UNIQUE("channel","source_message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"account_id" uuid,
	"state" "session_state" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"trigger" "session_trigger",
	"reasoning_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"text" text NOT NULL,
	"segments" jsonb,
	"language" text,
	"provider" "transcript_provider" NOT NULL,
	"cost_usd_millis" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposed_task_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_telegram_id" text,
	"actor_device_id" uuid,
	"actor_surface" text NOT NULL,
	"action" "approval_action" NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approved_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposed_task_id" uuid NOT NULL,
	"injaz_task_id" text,
	"sync_state" "sync_state" DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposed_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"reasoning_run_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"assignee_guess" text,
	"priority_guess" "priority" DEFAULT 'med' NOT NULL,
	"due_date_guess" timestamp with time zone,
	"rationale" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" "proposed_task_state" DEFAULT 'proposed' NOT NULL,
	"telegram_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reasoning_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text NOT NULL,
	"context_bundle" jsonb NOT NULL,
	"raw_response" jsonb,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_pairing_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairing_tokens_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"fcm_token" text,
	"api_key_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'super_admin' NOT NULL,
	"telegram_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"delivered_channels" text[] DEFAULT '{}' NOT NULL,
	"fallback_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" "cost_service" NOT NULL,
	"operation" text NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"session_id" uuid,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_identifiers" ADD CONSTRAINT "contact_identifiers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pending_identifiers" ADD CONSTRAINT "pending_identifiers_suggested_contact_id_contacts_id_fk" FOREIGN KEY ("suggested_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachments" ADD CONSTRAINT "attachments_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interactions" ADD CONSTRAINT "interactions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "interactions" ADD CONSTRAINT "interactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_proposed_task_id_proposed_tasks_id_fk" FOREIGN KEY ("proposed_task_id") REFERENCES "public"."proposed_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approved_tasks" ADD CONSTRAINT "approved_tasks_proposed_task_id_proposed_tasks_id_fk" FOREIGN KEY ("proposed_task_id") REFERENCES "public"."proposed_tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposed_tasks" ADD CONSTRAINT "proposed_tasks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposed_tasks" ADD CONSTRAINT "proposed_tasks_reasoning_run_id_reasoning_runs_id_fk" FOREIGN KEY ("reasoning_run_id") REFERENCES "public"."reasoning_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reasoning_runs" ADD CONSTRAINT "reasoning_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_pairing_tokens" ADD CONSTRAINT "device_pairing_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_pairing_tokens" ADD CONSTRAINT "device_pairing_tokens_consumed_by_device_id_devices_id_fk" FOREIGN KEY ("consumed_by_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_checksum_idx" ON "attachments" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interactions_session_occurred_idx" ON "interactions" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_contact_state_idx" ON "sessions" USING btree ("contact_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_last_activity_idx" ON "sessions" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_events_proposed_task_idx" ON "approval_events" USING btree ("proposed_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposed_tasks_session_state_idx" ON "proposed_tasks" USING btree ("session_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reasoning_runs_session_idx" ON "reasoning_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_read_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_kind_idx" ON "notifications" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_service_occurred_idx" ON "cost_events" USING btree ("service","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_session_idx" ON "cost_events" USING btree ("session_id");