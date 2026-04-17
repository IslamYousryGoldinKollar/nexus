import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Singleton Drizzle client backed by postgres-js.
 *
 * We target Supabase Postgres 17. Two connection strings exist:
 *
 * - `DATABASE_URL`         — pgbouncer-pooled, port 6543, `sslmode=require`.
 *                             Use this for app runtime (Next.js request handlers,
 *                             Inngest functions). Transaction-mode pooling, so
 *                             prepared statements are disabled via `prepare: false`.
 *
 * - `DATABASE_URL_UNPOOLED` — direct connection, port 5432. Use this for
 *                             migrations, long-running scripts, seeding.
 *
 * See: https://supabase.com/docs/guides/database/connecting-to-postgres
 */

type Mode = 'pooled' | 'unpooled';

let _db: ReturnType<typeof createDb> | null = null;
let _dbUnpooled: ReturnType<typeof createDb> | null = null;

function createDb(connectionString: string, mode: Mode) {
  const client = postgres(connectionString, {
    // pgbouncer transaction-mode doesn't support prepared statements.
    prepare: mode === 'unpooled',
    max: mode === 'unpooled' ? 1 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(client, { schema, casing: 'snake_case' });
}

/** App-runtime client — pooled connection, fast per-request. */
export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  _db = createDb(url, 'pooled');
  return _db;
}

/** Migration/script client — direct connection, supports transactions + DDL. */
export function getDbUnpooled() {
  if (_dbUnpooled) return _dbUnpooled;
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is not set');
  _dbUnpooled = createDb(url, 'unpooled');
  return _dbUnpooled;
}

export type Database = ReturnType<typeof createDb>;
export { schema };
