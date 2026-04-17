#!/usr/bin/env tsx
/**
 * Apply Drizzle migrations against the database in DATABASE_URL_UNPOOLED
 * (fall back to DATABASE_URL). Run from CI or manually via `pnpm db:migrate`.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');

  // eslint-disable-next-line no-console
  console.log('[migrate] connecting to Neon …');
  const sql = neon(url);
  const db = drizzle(sql);

  const migrationsFolder = path.resolve(__dirname, '..', 'drizzle');
  // eslint-disable-next-line no-console
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);

  await migrate(db, { migrationsFolder });
  // eslint-disable-next-line no-console
  console.log('[migrate] ✔ done');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] ✖ failed', err);
  process.exit(1);
});
