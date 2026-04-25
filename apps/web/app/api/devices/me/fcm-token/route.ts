import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb, updateDeviceFcmToken } from '@nexus/db';
import { verifyDeviceBearer } from '@/lib/auth/device';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';

const bodySchema = z.object({ fcmToken: z.string().min(20) });

/**
 * PUT /api/devices/me/fcm-token
 * Auth: device API key in Authorization: Bearer header.
 * Body: { fcmToken }
 *
 * Idempotent: same token → no-op except for last_seen_at refresh.
 * Rate limited to prevent abuse.
 */
export async function PUT(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for device endpoint
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('device.fcm_token.rate_limited');
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }

    const device = await verifyDeviceBearer(req.headers.get('authorization'));
    if (!device) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    let body: { fcmToken: string };
    try {
      body = bodySchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
    }

    await updateDeviceFcmToken(getDb(), device.id, body.fcmToken);
    log.info('device.fcm_token.updated', { deviceId: device.id });
    return NextResponse.json({ ok: true });
  });
}
