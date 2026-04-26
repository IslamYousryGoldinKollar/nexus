#!/usr/bin/env tsx
/**
 * One-shot script to apply migration 0003 (Injaz mapping columns)
 * directly, bypassing the Drizzle migration journal — production DB
 * was bootstrapped with `db:push` so the journal was never seeded
 * and `db:migrate` would try to replay 0000 from scratch.
 *
 * The SQL itself is all `IF NOT EXISTS`-guarded so re-running is safe.
 * Delete this file once the migration journal is properly seeded.
 */
import 'dotenv/config';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');

  const client = postgres(url, { max: 1 });
  try {
    console.log('[apply-0003] adding injaz_party_name…');
    await client`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "injaz_party_name" text`;
    console.log('[apply-0003] adding injaz_project_name…');
    await client`ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "injaz_project_name" text`;
    console.log('[apply-0003] adding assignee_injaz_user_name…');
    await client`ALTER TABLE "proposed_tasks" ADD COLUMN IF NOT EXISTS "assignee_injaz_user_name" text`;
    console.log('[apply-0003] done');
  } finally {
    await client.end();
  }
}

void main().catch((e) => {
  console.error('[apply-0003] failed:', e);
  process.exit(1);
});
