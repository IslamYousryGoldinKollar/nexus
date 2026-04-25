import { NextResponse, type NextRequest } from 'next/server';
import {
  gmailNotificationSchema,
  pubsubPushSchema,
} from '@/lib/channels/gmail/schema';
import { PubsubJwtError, verifyPubsubOidcToken } from '@/lib/channels/gmail/verify-oidc';
import { serverEnv } from '@/lib/env';
import { inngest } from '@/lib/inngest';
import { log } from '@/lib/logger';
import { parseJsonFromBytes, readRawBody } from '@/lib/raw-body';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';
import { ack, signatureFailed } from '@/lib/webhook-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Gmail → Pub/Sub push target.
 *
 * Phase 1.5 scope:
 *   - Verify the Google-signed OIDC JWT on every request.
 *   - Decode the Pub/Sub envelope.
 *   - Emit Inngest event to fetch email content and create interactions.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, webhookRateLimiter);
  if (!rateLimit.allowed) {
    log.warn('gmail.webhook.rate_limited');
    return new NextResponse('rate_limited', {
      status: 429,
      headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
    });
  }

  const authz = req.headers.get('authorization') ?? '';
  const token = authz.toLowerCase().startsWith('bearer ')
    ? authz.slice(7).trim()
    : '';

  // Audience defaults to the push endpoint URL — override via env for
  // local dev where the tunnel URL differs from the configured audience.
  const expectedAudience =
    process.env.GMAIL_PUBSUB_EXPECTED_AUDIENCE ||
    `${serverEnv.APP_URL.replace(/\/+$/, '')}/api/ingest/gmail`;

  try {
    await verifyPubsubOidcToken({
      token,
      expectedAudience,
      expectedServiceAccountEmail: process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT,
    });
  } catch (err) {
    if (err instanceof PubsubJwtError) {
      log.warn('gmail.jwt.invalid', {
        reason: err.reason,
        audience: expectedAudience,
      });
    } else {
      log.error('gmail.jwt.unexpected_error', { err: (err as Error).message });
    }
    return signatureFailed('gmail');
  }

  const raw = await readRawBody(req);
  let payload: unknown;
  try {
    payload = parseJsonFromBytes(raw);
  } catch (err) {
    log.warn('gmail.body.invalid_json', { err: (err as Error).message });
    return ack({ ignored: 'invalid_json' });
  }

  const parsed = pubsubPushSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn('gmail.envelope.invalid', {
      issues: parsed.error.issues.slice(0, 3).map((i) => i.message),
    });
    return ack({ ignored: 'envelope_mismatch' });
  }

  let decoded: unknown;
  try {
    const text = Buffer.from(parsed.data.message.data, 'base64').toString('utf-8');
    decoded = JSON.parse(text);
  } catch (err) {
    log.warn('gmail.data.decode_failed', { err: (err as Error).message });
    return ack({ ignored: 'decode_failed' });
  }

  const notif = gmailNotificationSchema.safeParse(decoded);
  if (!notif.success) {
    log.warn('gmail.notification.invalid', {
      issues: notif.error.issues.slice(0, 3).map((i) => i.message),
    });
    return ack({ ignored: 'notification_mismatch' });
  }

  log.info('gmail.notification.received', {
    emailAddress: notif.data.emailAddress,
    historyId: notif.data.historyId,
    messageId: parsed.data.message.messageId,
  });

  // Emit Inngest event to process Gmail notification
  await inngest.send({
    name: 'nexus/gmail.notification.received',
    data: {
      emailAddress: notif.data.emailAddress,
      historyId: notif.data.historyId,
      messageId: parsed.data.message.messageId,
    },
  });

  return ack({ notified: notif.data.emailAddress });
}
