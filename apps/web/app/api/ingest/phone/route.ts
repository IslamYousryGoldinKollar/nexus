import { NextResponse, type NextRequest } from 'next/server';
import { authorizePhoneUpload } from '@/lib/channels/phone/auth';
import { ingestPhoneCall } from '@/lib/channels/phone/ingest';
import { phoneUploadMetaSchema } from '@/lib/channels/phone/schema';
import { log } from '@/lib/logger';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Phone call recordings can be large — give the function time to stream
// the upload to R2 and finish the DB insert.
export const maxDuration = 300;

/**
 * Phone-call recording ingest — Phase 1.
 *
 * Source: the Android `recording.UploadRecordingWorker` (and any
 * future on-device recorder). Each upload corresponds to one call.
 *
 * Auth: `Authorization: Bearer <device-api-key>` matched against the
 * comma-separated `PHONE_INGEST_API_KEYS` env var (constant-time
 * compare via `authorizePhoneUpload`). Phase 7 will replace pre-shared
 * keys with per-device API keys backed by the `devices` table.
 *
 * Body: `multipart/form-data`:
 *   - audio (file)        — m4a / mp4 / wav / mp3 / amr
 *   - meta  (JSON string) — see `phoneUploadMetaSchema`:
 *       counterparty (E.164), direction (inbound|outbound),
 *       startedAt (ISO datetime), durationSec (int),
 *       callId (UUID), recorder? (string)
 *
 * We always 200 on transient errors so WorkManager doesn't retry-storm.
 */
export async function POST(req: NextRequest) {
  return withRequestId(req, async () => {
    const rateLimit = checkRateLimit(req, webhookRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('phone.webhook.rate_limited');
      return new NextResponse('rate_limited', {
        status: 429,
        headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
      });
    }

    const auth = await authorizePhoneUpload(req);
    if (!auth.ok) {
      log.warn('phone.auth.invalid', { reason: auth.reason });
      return new NextResponse('Unauthorized', { status: 401 });
    }

    // Read the raw bytes first then construct a fresh Request to call
    // formData() on. Calling `req.formData()` directly on the
    // incoming NextRequest fails intermittently on Vercel's Node
    // runtime ("Failed to parse body as FormData") when the multipart
    // body is large or has been touched by an upstream proxy. The
    // meeting endpoint already uses this workaround; mirroring it
    // here is what unblocks Android phone uploads (commit 7843e48
    // tracked the issue).
    let form: FormData;
    let raw: Buffer | null = null;
    try {
      raw = Buffer.from(await req.arrayBuffer());
      const rebuilt = new Request(req.url, {
        method: 'POST',
        headers: req.headers,
        body: raw,
      });
      form = await rebuilt.formData();
    } catch (err) {
      // Diagnostic dump — Android Ktor's MultiPartFormDataContent has
      // shipped malformed bodies before. We log the Content-Type so we
      // can see whether the boundary parameter is present, the total
      // size, and the first / last 200 bytes of the body so a glance
      // tells us if the multipart preamble + closing delimiter look
      // sane. Tracking body[0..199] lets us catch "missing
      // --<boundary>" prefixes.
      const ct = req.headers.get('content-type') ?? '(missing)';
      const cl = req.headers.get('content-length') ?? '(missing)';
      const head = raw ? raw.subarray(0, 200).toString('utf-8') : '(no body)';
      const tail = raw && raw.length > 200 ? raw.subarray(raw.length - 200).toString('utf-8') : '';
      log.warn('phone.body.invalid_multipart', {
        err: (err as Error).message,
        contentType: ct,
        contentLength: cl,
        bytes: raw?.length ?? 0,
        bodyHead: head,
        bodyTail: tail,
      });
      return NextResponse.json({ ok: true, ignored: 'invalid_multipart' });
    }

    const audio = form.get('audio');
    if (!(audio instanceof File) || audio.size === 0) {
      log.warn('phone.body.no_audio', { filename: (audio as File | null)?.name });
      return NextResponse.json({ ok: true, ignored: 'no_audio' });
    }

    const metaRaw = form.get('meta');
    if (typeof metaRaw !== 'string') {
      log.warn('phone.body.no_meta');
      return NextResponse.json({ ok: true, ignored: 'no_meta' });
    }

    let parsedMeta: unknown;
    try {
      parsedMeta = JSON.parse(metaRaw);
    } catch (err) {
      log.warn('phone.body.meta_invalid_json', { err: (err as Error).message });
      return NextResponse.json({ ok: true, ignored: 'meta_invalid_json' });
    }

    const meta = phoneUploadMetaSchema.safeParse(parsedMeta);
    if (!meta.success) {
      log.warn('phone.body.meta_schema_mismatch', {
        issues: meta.error.issues.slice(0, 5).map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return NextResponse.json({ ok: true, ignored: 'meta_schema_mismatch' });
    }

    try {
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const result = await ingestPhoneCall({
        audio: bytes,
        mimeType: audio.type || 'audio/mp4',
        meta: meta.data,
      });
      log.info('phone.webhook.ingested', {
        interactionId: result.interactionId,
        sizeBytes: result.sizeBytes,
        r2Key: result.r2Key,
        alreadyExisted: result.alreadyExisted,
        counterparty: meta.data.counterparty,
        direction: meta.data.direction,
      });
      return NextResponse.json({
        ok: true,
        interactionId: result.interactionId,
        alreadyExisted: result.alreadyExisted,
      });
    } catch (err) {
      log.error('phone.webhook.ingest_failed', {
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
      // 200 + error so WorkManager doesn't retry-loop on a poison file.
      return NextResponse.json({ ok: true, error: 'ingest_failed' });
    }
  });
}
