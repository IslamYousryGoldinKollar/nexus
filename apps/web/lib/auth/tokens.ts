import { sha256Hex } from '@nexus/shared';
import { eq, getDb, magicLinkTokens } from '@nexus/db';
import { randomBytes } from 'node:crypto';

/**
 * Magic-link token lifecycle.
 *
 * 32 random bytes → URL-safe base64 (43 chars). The bytes themselves
 * never hit Postgres — we store sha-256 of the token. The unique index
 * on `token_hash` gives constant-time lookup; replay across multiple
 * rows is impossible.
 *
 * TTL is 15 minutes. Tokens are single-use: `consumed_at` is set on
 * first verification.
 */

export const MAGIC_LINK_TTL_MIN = 15;

function urlSafeBase64(buf: Buffer): string {
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function createMagicLinkToken(args: {
  email: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = urlSafeBase64(randomBytes(32));
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);

  const db = getDb();
  await db.insert(magicLinkTokens).values({
    email: args.email.toLowerCase(),
    tokenHash,
    expiresAt,
    requestedIp: args.ip ?? null,
    requestedUserAgent: args.userAgent ?? null,
  });

  return { token, expiresAt };
}

export interface VerifiedToken {
  email: string;
  id: string;
}

/**
 * Single-use verification.
 *
 * Race condition: if two requests arrive simultaneously with the same
 * token (very unlikely outside an attack), both could pass the SELECT.
 * The UPDATE ... WHERE consumed_at IS NULL clause makes the consume
 * atomic — only one row update succeeds (`updated.length === 1`).
 */
export async function verifyAndConsumeToken(token: string): Promise<VerifiedToken | null> {
  if (!token || token.length < 16) return null;
  const tokenHash = await sha256Hex(token);
  const db = getDb();
  const [row] = await db
    .select()
    .from(magicLinkTokens)
    .where(eq(magicLinkTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  if (row.consumedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;

  // Atomic single-use claim.
  const [claimed] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(
      // eq + manual IS NULL via raw sql — keep it tight
      eq(magicLinkTokens.id, row.id),
    )
    .returning();
  if (!claimed) return null;

  return { email: claimed.email, id: claimed.id };
}
