-- Edited from drizzle-kit generated output to use IF NOT EXISTS guards
-- everywhere. The schema columns referenced here have been used in
-- application code for weeks; production has had them applied via
-- `db:push` (Drizzle's dev shortcut) without a corresponding migration
-- file landing in the repo. CI's `db:generate` drift detector caught
-- the gap on 2026-04-26. Re-running this migration on prod must be a
-- no-op, hence the guards below.

DO $$ BEGIN
    ALTER TYPE "public"."cost_service" ADD VALUE 'openai' BEFORE 'openai_whisper';
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "allow_transcription" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "allow_action" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel" "channel";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "thread_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_thread_id_idx" ON "sessions" USING btree ("thread_id");
