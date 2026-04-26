#!/usr/bin/env tsx
/**
 * Read-only exploration of the Injaz Postgres database. Used to design
 * the "list existing tasks for context-aware reasoning" feature so the
 * AI can decide update-vs-create instead of always creating duplicates.
 *
 * Connection string lives in INJAZ_DATABASE_URL (direct, not Accelerate).
 * Run: INJAZ_DATABASE_URL=... pnpm --filter @nexus/db exec tsx scripts/explore-injaz.ts
 */
import 'dotenv/config';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.INJAZ_DATABASE_URL;
  if (!url) throw new Error('INJAZ_DATABASE_URL must be set');

  const c = postgres(url, { max: 1, ssl: 'require' });
  try {
    const tables = await c`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    console.log('=== Tables in public schema ===');
    console.log(tables.map((t) => t.table_name).join('\n'));

    const taskTables = tables
      .map((t) => t.table_name as string)
      .filter((n) => /task|project|user|party|client/i.test(n));

    for (const t of taskTables) {
      console.log(`\n--- ${t} columns ---`);
      const cols = await c`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${t}
        ORDER BY ordinal_position
      `;
      for (const c2 of cols) console.log(`  ${c2.column_name} (${c2.data_type}${c2.is_nullable === 'NO' ? ', not null' : ''})`);

      const sample = await c.unsafe(`SELECT * FROM "${t}" LIMIT 2`);
      console.log(`  sample (${sample.length} rows):`);
      for (const r of sample) console.log('    ', JSON.stringify(r).slice(0, 280));
    }
  } finally {
    await c.end();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
