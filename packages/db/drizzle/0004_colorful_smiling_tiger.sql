-- Edited from drizzle-kit generated output to use IF NOT EXISTS guards.
-- Same convention as migrations 0002/0003 — production has been
-- bootstrapped via db:push more than once.

ALTER TABLE "proposed_tasks" ADD COLUMN IF NOT EXISTS "injaz_existing_task_id" text;
