-- Edited from drizzle-kit generated output to use IF NOT EXISTS guards.
-- Same convention as migration 0002 — production runs db:push during
-- early development, so the columns may already exist when CI applies
-- the migration. Re-running this on prod must be a no-op.

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "injaz_party_name" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "injaz_project_name" text;--> statement-breakpoint
ALTER TABLE "proposed_tasks" ADD COLUMN IF NOT EXISTS "assignee_injaz_user_name" text;
