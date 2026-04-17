import { neon, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema/index.js';

/**
 * Singleton Drizzle client backed by Neon's serverless driver.
 *
 * Uses `neon-http` (HTTP fetch) which is optimal for Vercel serverless
 * functions — no connection pooling concerns, per-request TCP.
 *
 * For long-running workloads (scripts, Inngest background workers) prefer
 * `neon-serverless` with the WebSocket driver — add a second factory later.
 */

neonConfig.fetchConnectionCache = true;

let _db: ReturnType<typeof createDb> | null = null;

function createDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzle(sql, { schema, casing: 'snake_case' });
}

export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  _db = createDb(url);
  return _db;
}

export type Database = ReturnType<typeof createDb>;
export { schema };
