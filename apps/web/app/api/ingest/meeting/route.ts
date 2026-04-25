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

    const secret = process.env.WA_BRIDGE_HMAC_SECRET;
    if (!secret) {
      log.error('meeting.webhook.no_secret');
      return NextResponse.json(
        { ok: false, error: 'signature_verification_failed', channel: 'meeting' },
        { status: 200 },
      );
    }

    const raw = Buffer.from(await req.arrayBuffer());
    const sig = req.headers.get('x-nexus-signature') ?? '';
    const match = sig.match(/^sha256=([a-f0-9]{64})$/i);
    if (!match) {
      log.warn('meeting.signature.malformed', { bodyLen: raw.length });
      return NextResponse.json(
        { ok: false, error: 'signature_verification_failed', channel: 'meeting' },
        { status: 200 },
      );
    }
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const provided = match[1]!;
    if (!timingSafeHexEq(expected, provided)) {
      log.warn('meeting.signature.invalid', { bodyLen: raw.length });
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
