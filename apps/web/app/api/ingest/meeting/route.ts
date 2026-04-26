import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';
import { ingestMeetingRecording } from '@/lib/channels/meeting/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Meetings can be up to an hour; give the function time to stream the
// upload into Supabase Storage before timing out.
export const maxDuration = 300;

/**
 * Meeting-audio ingest.
 *
 * Source: the `nexus-mac-recorder` menu-bar app (Teams / Zoom / Meet /
 *   any macOS audio source captured via ScreenCaptureKit).
 *
 * Contract:
 *   - Method: POST /api/ingest/meeting
 *   - Auth:   HMAC-SHA256 of the raw body with `WA_BRIDGE_HMAC_SECRET`
 *             (we reuse the same secret so the operator has one key to
 *             rotate across mobile/desktop clients).
 *   - Header: `X-Nexus-Signature: sha256=<hex>`
 *   - Body:   multipart/form-data with fields
 *             - audio (file, audio/mp4)
 *             - startedAt, endedAt (ISO-8601)
 *             - device (free-form label)
 *             - source (e.g. "macos-recorder")
 *
 * We always return 200 on internal failures (structured logs capture
 * the real error) so the client doesn't retry a poison file forever.
 */

function timingSafeHexEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function verifyHmac(req: NextRequest, raw: Buffer): boolean {
  const secret = process.env.WA_BRIDGE_HMAC_SECRET;
  if (!secret) return false;
  const sig = req.headers.get('x-nexus-signature') ?? '';
  const match = sig.match(/^sha256=([a-f0-9]{64})$/i);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  return timingSafeHexEq(expected, match[1]!);
}

function verifyBearer(req: NextRequest): boolean {
  const provided = (req.headers.get('authorization') ?? '').trim();
  if (!provided.startsWith('Bearer ')) return false;
  const token = provided.slice('Bearer '.length).trim();
  if (!token) return false;
  // Two acceptable keys: a dedicated MEETING_INGEST_API_KEY (preferred)
  // or the existing TEAMS_INGEST_API_KEY (backward-compat with the
  // legacy DM-scraper extension's stored secret).
  for (const envName of ['MEETING_INGEST_API_KEY', 'TEAMS_INGEST_API_KEY']) {
    const want = process.env[envName]?.trim();
    if (!want) continue;
    if (
      token.length === want.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(want))
    ) {
      return true;
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  return withRequestId(req, async () => {
    const rateLimit = checkRateLimit(req, webhookRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('meeting.webhook.rate_limited');
      return new NextResponse('rate_limited', {
        status: 429,
        headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
      });
    }

    const raw = Buffer.from(await req.arrayBuffer());

    // Two auth modes (either passing is sufficient):
    //   1. HMAC-SHA256 of the raw body — for the macOS recorder and
    //      other backend clients that can safely hold WA_BRIDGE_HMAC_SECRET.
    //   2. Bearer MEETING_INGEST_API_KEY (or TEAMS_INGEST_API_KEY as
    //      fallback) — for the Chrome extension. A bearer in the
    //      extension bundle is acceptable because (a) it's a personal
    //      install, not Web Store distribution, and (b) it's scoped to
    //      this single endpoint with strict rate limiting.
    const hmacOk = verifyHmac(req, raw);
    const bearerOk = verifyBearer(req);
    if (!hmacOk && !bearerOk) {
      log.warn('meeting.auth.failed', { bodyLen: raw.length });
      return NextResponse.json(
        { ok: false, error: 'signature_verification_failed', channel: 'meeting' },
        { status: 200 },
      );
    }

    // Parse multipart via the web-standard FormData API (Node 20+).
    // We already consumed the body as a Buffer for HMAC, so rebuild a
    // Request-like wrapper around the raw bytes.
    let form: FormData;
    try {
      const rebuilt = new Request(req.url, {
        method: 'POST',
        headers: req.headers,
        body: raw,
      });
      form = await rebuilt.formData();
    } catch (err) {
      log.warn('meeting.body.invalid_multipart', { err: (err as Error).message });
      return NextResponse.json({ ok: true, ignored: 'invalid_multipart' });
    }

    const audio = form.get('audio');
    const startedAt = form.get('startedAt')?.toString() ?? '';
    const endedAt = form.get('endedAt')?.toString() ?? '';
    const device = form.get('device')?.toString() ?? 'mac';
    const source = form.get('source')?.toString() ?? 'macos-recorder';

    if (!(audio instanceof File) || audio.size === 0) {
      log.warn('meeting.body.no_audio', { device, source });
      return NextResponse.json({ ok: true, ignored: 'no_audio' });
    }
    if (!startedAt || !endedAt) {
      log.warn('meeting.body.missing_times', { device, source });
      return NextResponse.json({ ok: true, ignored: 'missing_times' });
    }

    try {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const result = await ingestMeetingRecording({
        audio: bytes,
        mimeType: audio.type || 'audio/mp4',
        meta: {
          startedAt,
          endedAt,
          device,
          source,
          filename: audio.name || 'meeting.m4a',
        },
      });
      log.info('meeting.webhook.ingested', {
        interactionId: result.interactionId,
        sizeBytes: result.sizeBytes,
        storageKey: result.storageKey,
        alreadyExisted: result.alreadyExisted,
      });
      return NextResponse.json({ ok: true, ingested: true, interactionId: result.interactionId });
    } catch (err) {
      log.error('meeting.webhook.ingest_failed', {
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
      return NextResponse.json({ ok: true, error: 'ingest_failed' });
    }
  });
}

export function GET() {
  return NextResponse.json({ ok: true, service: 'meeting' });
}
