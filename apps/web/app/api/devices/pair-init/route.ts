import { NextResponse } from 'next/server';
import { createPairingToken, eq, getDb, users } from '@nexus/db';
import { generatePairingCode, hashPairingCode } from '@/lib/auth/device';
import { readSession } from '@/lib/auth/session';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { log } from '@/lib/logger';

/**
 * POST /api/devices/pair-init
 *
 * Auth: admin session cookie. Generates a 6-char alphanumeric code and
 * stores its sha-256 hash. Returns the plaintext code ONCE; admin shows
 * it as a QR + raw text on the settings page so a phone can claim it.
 *
 * Response: { code, expiresAt, ttlMinutes }
 */
export async function POST() {
  const session = await readSession();
  if (!session || !isAllowedAdmin(session.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = getDb();
  // Resolve the user row by email — there should only ever be one for v1.
  const [user] = await db.select().from(users).where(eq(users.email, session.email)).limit(1);
  if (!user) {
    log.warn('pair_init.user_not_found', { email: session.email });
    // Soft-fail with 200 + an explanatory error so the admin sees the cause
    // rather than a generic 500.
    return NextResponse.json(
      { error: 'user_row_missing', hint: 'insert a row into users table for this email' },
      { status: 412 },
    );
  }

  const code = generatePairingCode();
  const codeHash = await hashPairingCode(code);
  const ttl = 10;

  const token = await createPairingToken(db, {
    userId: user.id,
    codeHash,
    ttlMinutes: ttl,
  });

  log.info('pair_init.created', { userId: user.id, tokenId: token.id });
  return NextResponse.json({
    code,
    expiresAt: token.expiresAt.toISOString(),
    ttlMinutes: ttl,
  });
}
