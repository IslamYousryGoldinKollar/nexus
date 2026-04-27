-- Edited from drizzle-kit generated output to use IF NOT EXISTS guards.
-- Same convention as migrations 0002/0003/0004 — production may have
-- run db:push between branches.

ALTER TABLE "proposed_tasks" ADD COLUMN IF NOT EXISTS "start_date_guess" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposed_tasks" ADD COLUMN IF NOT EXISTS "create_client_name" text;--> statement-breakpoint
ALTER TABLE "proposed_tasks" ADD COLUMN IF NOT EXISTS "create_project_name" text;
