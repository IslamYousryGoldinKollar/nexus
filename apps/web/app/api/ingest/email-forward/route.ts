import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getDb, upsertInteraction } from '@nexus/db';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Lightweight email-forward ingest. Designed for the Gmail Apps Script
 * forwarder (10-line script attached to a label-watch trigger), or any
 * other forwarder that can POST JSON.
 *
 * Why this exists alongside /api/ingest/gmail:
 *   - /api/ingest/gmail is the proper Gmail OAuth + Pub/Sub push path.
 *     It needs Google Cloud OAuth credentials, a Pub/Sub topic +
 *     subscription, and a one-time refresh-token grant.
 *   - This endpoint is the "5-minute setup" alternative: paste an
 *     Apps Script into your Google account, set EMAIL_INGEST_API_KEY
 *     in Vercel, done.
 *
 * Auth: Bearer EMAIL_INGEST_API_KEY (constant-time compare).
 *
 * Body (JSON):
 *   {
 *     from: string,          // sender email
 *     to?: string,           // your address (defaults to "self")
 *     subject?: string,
 *     body: string,          // plain text or stripped HTML
 *     messageId: string,     // gmail message id; primary dedup key
 *     occurredAt: string,    // ISO 8601
 *     headers?: Record<string, string>
 *   }
 *
 * Always 200 on transient failures so the forwarder doesn't retry-storm.
 */

const bodySchema = z.object({
  from: z.string().email().or(z.string().min(3).max(200)),
  to: z.string().optional(),
  subject: z.string().max(998).optional(),
  body: z.string().min(1).max(50_000),
  messageId: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  headers: z.record(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  return withRequestId(req, async () => {
    const rateLimit = checkRateLimit(req, webhookRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('email.webhook.rate_limited');
      return new NextResponse('rate_limited', {
        status: 429,
        headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
      });
    }

    const apiKey = process.env.EMAIL_INGEST_API_KEY?.trim();
    if (!apiKey) {
      log.error('email.webhook.no_key');
      return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });
    }
    const provided = (req.headers.get('authorization') ?? '').trim();
    if (!provided.startsWith('Bearer ')) {
      log.warn('email.webhook.no_bearer');
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    const token = provided.slice('Bearer '.length).trim();
    const a = Buffer.from(token);
    const b = Buffer.from(apiKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      log.warn('email.webhook.bad_bearer');
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    let parsed: z.infer<typeof bodySchema>;
    try {
      const json = await req.json();
      parsed = bodySchema.parse(json);
    } catch (err) {
      log.warn('email.webhook.invalid_payload', { err: (err as Error).message });
      return NextResponse.json({ ok: true, ignored: 'invalid_payload' });
    }

    // Pull a clean email out of the from field — Apps Script gives us
    // "Name <addr@example.com>" sometimes.
    const fromEmail = extractEmail(parsed.from);
    if (!fromEmail) {
      log.warn('email.webhook.no_from_email', { from: parsed.from });
      return NextResponse.json({ ok: true, ignored: 'no_from_email' });
    }

    // Stable dedup id derived from from+messageId so a re-forwarded
    // copy lands on the same row. Gmail messageId alone isn't quite
    // unique cross-account.
    const sourceMessageId = `email:${createHash('sha256')
      .update(`${fromEmail}|${parsed.messageId}`)
      .digest('hex')
      .slice(0, 32)}`;

    const text =
      (parsed.subject ? `Subject: ${parsed.subject}\n\n` : '') + parsed.body.trim();

    try {
      const db = getDb();
      const { interaction, inserted } = await upsertInteraction(db, {
        channel: 'gmail',
        direction: 'inbound',
        contentType: 'email_body',
        text,
        sourceMessageId,
        occurredAt: new Date(parsed.occurredAt),
        rawPayload: {
          from: fromEmail,
          to: parsed.to ?? null,
          subject: parsed.subject ?? null,
          messageId: parsed.messageId,
          headers: parsed.headers ?? null,
          bodyLength: parsed.body.length,
        },
      });

      log.info('email.webhook.ingested', {
        interactionId: interaction.id,
        inserted,
        from: fromEmail,
        subject: parsed.subject?.slice(0, 80),
      });
      return NextResponse.json({
        ok: true,
        interactionId: interaction.id,
        inserted,
      });
    } catch (err) {
      log.error('email.webhook.ingest_failed', {
        err: (err as Error).message,
        stack: (err as Error).stack,
      });
      return NextResponse.json({ ok: true, error: 'ingest_failed' });
    }
  });
}

function extractEmail(s: string): string | null {
  const m = s.match(/[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}
