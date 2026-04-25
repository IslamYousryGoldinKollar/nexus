import { NextResponse, type NextRequest } from 'next/server';
import { verifyHmac } from '@nexus/shared';
import { ingestBaileysEnvelope } from '@/lib/channels/whatsapp/baileys-ingest';
import { baileysEnvelopeSchema } from '@/lib/channels/whatsapp/baileys-schema';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { parseJsonFromBytes, readRawBody } from '@/lib/raw-body';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';
import { ack, signatureFailed } from '@/lib/webhook-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Baileys bridge ingestion endpoint.
 *
 * The `@nexus/wa-bridge` worker (deployed on Fly.io / Railway) POSTs a
 * normalized `BaileysEnvelope` to this route after each `messages.upsert`
 * notification from WhatsApp. Media has already been uploaded to Supabase
 * Storage by the bridge — we just record attachments by storage key.
 *
 * Auth: HMAC SHA-256 over the raw body, shared secret `WA_BRIDGE_HMAC_SECRET`.
 * Header: `X-Nexus-Signature: sha256=<hex>` (mirrors Meta's format so the
 * existing `verifyHmac` helper works unchanged).
 *
 * We always return 200 on ingestion errors so the bridge doesn't spin on
 * retries for a poison message; structured logs surface real problems.
 */

export async function POST(req: NextRequest) {
  return withRequestId(req, async () => {
    const rateLimit = checkRateLimit(req, webhookRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('wa_baileys.webhook.rate_limited');
      return new NextResponse('rate_limited', {
        status: 429,
        headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
      });
    }

    const secret = process.env.WA_BRIDGE_HMAC_SECRET;
    if (!secret) {
      log.error('wa_baileys.webhook.no_secret');
      return signatureFailed('whatsapp-baileys');
    }

    const raw = await readRawBody(req);
    const signature = req.headers.get('x-nexus-signature') ?? '';
    const valid = await verifyHmac(secret, raw, signature, 'SHA-256');
    if (!valid) {
      log.warn('wa_baileys.signature.invalid', {
        hasSignature: !!signature,
        bodyLen: raw.length,
      });
      return signatureFailed('whatsapp-baileys');
    }

    let payload: unknown;
    try {
      payload = parseJsonFromBytes(raw);
    } catch (err) {
      log.warn('wa_baileys.body.invalid_json', { err: (err as Error).message });
      return ack({ ignored: 'invalid_json' });
    }

    const parsed = baileysEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn('wa_baileys.schema.mismatch', {
        issues: parsed.error.issues.slice(0, 5).map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return ack({ ignored: 'schema_mismatch' });
    }

    try {
      const outcomes = await ingestBaileysEnvelope(parsed.data);
      const inserted = outcomes.filter((o) => o.inserted).length;
      const skipped = outcomes.filter((o) => o.skipped).length;
      log.info('wa_baileys.webhook.ingested', {
        total: outcomes.length,
        inserted,
        skipped,
        device: parsed.data.device,
      });
      return ack({ ingested: inserted, skipped, total: outcomes.length });
    } catch (err) {
      log.error('wa_baileys.webhook.ingest_failed', {
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
      return ack({ error: 'ingest_failed' });
    }
  });
}

export function GET() {
  // Liveness probe for the bridge to sanity-check URL/secret during bootstrap.
  return NextResponse.json({ ok: true, service: 'whatsapp-baileys' });
}
