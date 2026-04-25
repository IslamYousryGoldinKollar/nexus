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
  fcmToken: z.string().optional(),
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
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
    }

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
