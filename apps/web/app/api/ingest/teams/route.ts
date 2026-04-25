import { NextResponse, type NextRequest } from 'next/server';
import { safeStringEqual } from '@nexus/shared';
import { ingestTeamsMessage } from '@/lib/channels/teams/ingest';
import { teamsIngestSchema } from '@/lib/channels/teams/schema';
import { serverEnv } from '@/lib/env';
import { log } from '@/lib/logger';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';
import { ack, signatureFailed, badRequest } from '@/lib/webhook-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/ingest/teams
 *
 * Auth: Bearer TEAMS_INGEST_API_KEY (constant-time compare).
 * Body: TeamsIngestPayload (one DOM-scraped message at a time).
 *
 * The Chrome extension is intentionally dumb: it streams one message
 * per request. De-duplication happens server-side via upsertInteraction.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, webhookRateLimiter);
  if (!rateLimit.allowed) {
    log.warn('teams.webhook.rate_limited');
    return new NextResponse('rate_limited', {
      status: 429,
      headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
    });
  }

  const expected = serverEnv.TEAMS_INGEST_API_KEY;
  if (!expected) {
    log.error('teams.no_key_configured', {});
    return signatureFailed('teams');
  }

  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeStringEqual(bearer, expected)) {
    log.warn('teams.auth.invalid', { hasHeader: !!auth });
    return signatureFailed('teams');
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return badRequest('invalid_json');
  }

  const parsed = teamsIngestSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn('teams.schema.mismatch', {
      issues: parsed.error.issues.slice(0, 5).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return badRequest('schema_mismatch');
  }

  try {
    const result = await ingestTeamsMessage(parsed.data);
    log.info('teams.ingested', {
      messageId: parsed.data.messageId,
      inserted: result.inserted,
      hasAttachment: !!result.attachmentId,
    });
    return ack({
      interactionId: result.interactionId,
      inserted: result.inserted,
      attachmentId: result.attachmentId,
    });
  } catch (err) {
    log.error('teams.ingest_failed', { err: (err as Error).message });
    return ack({ error: 'ingest_failed' });
  }
}
