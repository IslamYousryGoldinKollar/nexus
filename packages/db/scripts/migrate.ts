#!/usr/bin/env tsx
/**
 * Apply Drizzle migrations against the database in DATABASE_URL_UNPOOLED
 * (fall back to DATABASE_URL). Run from CI or manually via `pnpm db:migrate`.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');

  // eslint-disable-next-line no-console
  console.log('[migrate] connecting …');
  const client = postgres(url, { max: 1, prepare: true });
  const db = drizzle(client);

  const migrationsFolder = path.resolve(__dirname, '..', 'drizzle');
  // eslint-disable-next-line no-console
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);

  await migrate(db, { migrationsFolder });
  await client.end();

  // eslint-disable-next-line no-console
  console.log('[migrate] ✔ done');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] ✖ failed', err);
  process.exit(1);
});
