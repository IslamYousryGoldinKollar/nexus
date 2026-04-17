#!/usr/bin/env tsx
/**
 * Seed the development database with a single super-admin user (Islam)
 * and demo accounts. Idempotent — safe to re-run.
 *
 * Run with: pnpm --filter @nexus/db db:seed
 */
import 'dotenv/config';
import { accounts, getDb, users } from '../src/index.js';

async function main() {
  const db = getDb();

  const email =
    process.env.ADMIN_ALLOWED_EMAILS?.split(',')[0]?.trim().toLowerCase() ??
    'islam@goldinkollar.com';

  // eslint-disable-next-line no-console
  console.log(`[seed] upserting super-admin user: ${email}`);

  await db
    .insert(users)
    .values({
      email,
      displayName: 'Islam',
      role: 'super_admin',
    })
    .onConflictDoNothing({ target: users.email });

  // eslint-disable-next-line no-console
  console.log('[seed] upserting demo accounts');

  const demoAccounts = [
    { name: 'e& Egypt', domain: 'etisalat.com' },
    { name: 'GoldinKollar (internal)', domain: 'goldinkollar.com' },
  ];

  for (const a of demoAccounts) {
    await db.insert(accounts).values(a).onConflictDoNothing();
  }

  // eslint-disable-next-line no-console
  console.log('[seed] ✔ done');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] ✖ failed', err);
  process.exit(1);
});
