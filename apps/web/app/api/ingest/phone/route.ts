import { NextResponse, type NextRequest } from 'next/server';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Phone call recordings can be large — raise the body size and give
// the function longer to stream the upload to R2 during Phase 1.
export const maxDuration = 60;

/**
 * Phone call recording ingest — Phase 0 stub.
 *
 * Expects a multipart upload from the Android recorder app:
 *   - `Authorization: Bearer <device-api-key>` (matched against
 *     PHONE_INGEST_API_KEYS) plus an HMAC body signature.
 *   - FormData:
 *       audio (file, m4a / opus / wav)
 *       counterpartyE164 (string)
 *       startedAt (ISO datetime)
 *       durationSec (number)
 *       direction (inbound|outbound)
 *
 * Phase 1 will:
 *   1. Verify API key + HMAC.
 *   2. Stream audio to R2 under a checksum-derived key.
 *   3. Insert `interactions` row (content_type=call) + `attachments` row.
 *   4. Enqueue `nexus/interaction.ingested` for downstream pipeline.
 */
export async function POST(req: NextRequest) {
  return withRequestId(req, async () => {
    const auth = req.headers.get('authorization');
    const allowedKeys = (process.env.PHONE_INGEST_API_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (allowedKeys.length > 0) {
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!bearer || !allowedKeys.includes(bearer)) {
        return new NextResponse('Unauthorized', { status: 401 });
      }
    }

    return NextResponse.json({ ok: true, phase: 0 });
  });
}
