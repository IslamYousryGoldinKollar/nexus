import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { consumePairingToken, createDevice, getDb } from '@nexus/db';
import { generateDeviceApiKey, hashApiKey, hashPairingCode } from '@/lib/auth/device';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';

/**
 * POST /api/devices/pair-claim
 *
 * Auth: none — relies on the unguessable pairing code (32^6 ≈ 1B
 * combos, 10-min TTL, single-use). Standard short-code-pairing pattern.
 * Rate limited to prevent brute force attacks on pairing codes.
 *
 * Body: { code, name, platform, fcmToken? }
 *
 * On success returns { apiKey, deviceId } — the apiKey is shown once and
 * the Android app stores it in EncryptedSharedPreferences.
 */

const bodySchema = z.object({
  code: z.string().min(4).max(16),
  name: z.string().min(1).max(80),
  // Schema enum is android|ios|web; chrome_extension uses 'web' for now.
  platform: z.enum(['android', 'ios', 'web']),
  // `nullable()` so explicit `{"fcmToken": null}` from the Android client
  // (kotlinx serializer doesn't always honor explicitNulls=false on data
  // class properties) doesn't trip the schema.
  fcmToken: z.string().nullable().optional(),
});

export async function POST(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for pairing endpoint
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('pair_claim.rate_limited');
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch (err) {
      log.warn('pair_claim.body_not_json', { err: (err as Error).message });
      return NextResponse.json({ error: 'invalid_payload', reason: 'body_not_json' }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn('pair_claim.schema_mismatch', {
        issues: parsed.error.issues.slice(0, 6).map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
        // Surface the actual keys we received (not the values — could be sensitive).
        received_keys: raw && typeof raw === 'object' ? Object.keys(raw as object) : null,
      });
      return NextResponse.json(
        {
          error: 'invalid_payload',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }
    const body = parsed.data;

    const db = getDb();
    const codeHash = await hashPairingCode(body.code);
    const claim = await consumePairingToken(db, codeHash);
    if (!claim.ok) {
      log.warn('pair_claim.invalid_or_expired', {});
      return NextResponse.json({ error: 'invalid_or_expired' }, { status: 401 });
    }

    const apiKey = generateDeviceApiKey();
    const apiKeyHash = await hashApiKey(apiKey);

    const device = await createDevice(db, {
      userId: claim.row.userId,
      name: body.name,
      platform: body.platform,
      fcmToken: body.fcmToken ?? null,
      apiKeyHash,
      lastSeenAt: new Date(),
    });

    log.info('pair_claim.success', { deviceId: device.id, platform: body.platform });
    return NextResponse.json({
      deviceId: device.id,
      apiKey,
      userId: claim.row.userId,
    });
  });
}
