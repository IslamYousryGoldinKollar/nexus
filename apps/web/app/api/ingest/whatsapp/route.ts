import { NextResponse, type NextRequest } from 'next/server';
import { verifyHmac, safeStringEqual } from '@nexus/shared';
import { ingestWhatsappWebhook } from '@/lib/channels/whatsapp/ingest';
import { whatsappWebhookSchema } from '@/lib/channels/whatsapp/schema';
import { serverEnv } from '@/lib/env';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { parseJsonFromBytes, readRawBody } from '@/lib/raw-body';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';
import { ack, forbidden, signatureFailed } from '@/lib/webhook-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * WhatsApp Cloud API webhook.
 *
 * GET: Meta's subscription-verification handshake.
 *   → expects `hub.mode=subscribe` + `hub.verify_token=${WHATSAPP_VERIFY_TOKEN}`
 *   → returns `hub.challenge` verbatim on success.
 *
 * POST: incoming message notifications.
 *   1. Verify HMAC SHA-256 signature against app-secret (X-Hub-Signature-256)
 *   2. Zod-parse the payload
 *   3. Upsert interactions (idempotent) + download media → R2
 *   4. Emit `nexus/interaction.ingested` for downstream durable workflows
 *   5. Return 200 within 5 s (Meta retries slow acks)
 */

export function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const params = req.nextUrl.searchParams;
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge');

    const expected = serverEnv.WHATSAPP_VERIFY_TOKEN;
    if (
      mode === 'subscribe' &&
      expected &&
      token &&
      safeStringEqual(token, expected) &&
      challenge
    ) {
      return new NextResponse(challenge, { status: 200 });
    }
    log.warn('whatsapp.verify.rejected', { mode, hasToken: !!token });
    return forbidden('invalid_verify_token');
  });
}

export async function POST(req: NextRequest) {
  return withRequestId(req, async () => {
    const rateLimit = checkRateLimit(req, webhookRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('whatsapp.webhook.rate_limited');
      return new NextResponse('rate_limited', {
        status: 429,
        headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
      });
    }

    const appSecret = serverEnv.WHATSAPP_APP_SECRET;
    if (!appSecret) {
      // Missing secret means we cannot verify — safest to reject explicitly
      // while still 200-ing so Meta doesn't spam-retry.
      log.error('whatsapp.webhook.no_app_secret');
      return signatureFailed('whatsapp');
    }

    const raw = await readRawBody(req);
    const signature = req.headers.get('x-hub-signature-256') ?? '';
    const valid = await verifyHmac(appSecret, raw, signature, 'SHA-256');
    if (!valid) {
      log.warn('whatsapp.signature.invalid', {
        hasSignature: !!signature,
        bodyLen: raw.length,
      });
      return signatureFailed('whatsapp');
    }

    let payload: unknown;
    try {
      payload = parseJsonFromBytes(raw);
    } catch (err) {
      log.warn('whatsapp.body.invalid_json', { err: (err as Error).message });
      return ack({ ignored: 'invalid_json' });
    }

    const parsed = whatsappWebhookSchema.safeParse(payload);
    if (!parsed.success) {
      // We ACK so Meta doesn't retry, but we surface the schema error for
      // investigation — usually means a new message type we haven't modeled.
      log.warn('whatsapp.schema.mismatch', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return ack({ ignored: 'schema_mismatch' });
    }

    try {
      const outcomes = await ingestWhatsappWebhook(parsed.data, {
        receivedAt: new Date(),
      });
      const inserted = outcomes.filter((o) => o.inserted).length;
      const skipped = outcomes.filter((o) => o.skipped).length;
      log.info('whatsapp.webhook.ingested', {
        total: outcomes.length,
        inserted,
        skipped,
      });
      return ack({ ingested: inserted, skipped, total: outcomes.length });
    } catch (err) {
      log.error('whatsapp.webhook.ingest_failed', {
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
      // ACK on internal errors too — retrying won't help and our alerting
      // picks up the log event. TODO Phase 11: DLQ to a retry queue.
      return ack({ error: 'ingest_failed' });
    }
  });
}
