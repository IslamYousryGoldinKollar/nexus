import { NextResponse, type NextRequest } from 'next/server';
import { safeStringEqual } from '@nexus/shared';
import { handleTelegramCallback } from '@/lib/channels/telegram/approval';
import { handleTelegramCommand } from '@/lib/channels/telegram/commands';
import { ingestTelegramUpdate } from '@/lib/channels/telegram/ingest';
import { telegramUpdate } from '@/lib/channels/telegram/schema';
import { serverEnv } from '@/lib/env';
import { log } from '@/lib/logger';
import { parseJsonFromBytes, readRawBody } from '@/lib/raw-body';
import { checkRateLimit, webhookRateLimiter } from '@/lib/rate-limit';
import { ack, signatureFailed } from '@/lib/webhook-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Telegram Bot API webhook.
 *
 * Security: Telegram's `X-Telegram-Bot-Api-Secret-Token` header is set when
 * we register the webhook via `setWebhook?secret_token=…`. We reject any
 * request whose header doesn't match TELEGRAM_WEBHOOK_SECRET using a
 * constant-time comparison.
 *
 * Phase 1: inbound messages → `interactions` rows + downloaded media.
 * Phase 9 adds the approval-callback_query handlers.
 */
export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, webhookRateLimiter);
  if (!rateLimit.allowed) {
    log.warn('telegram.webhook.rate_limited');
    return new NextResponse('rate_limited', {
      status: 429,
      headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() },
    });
  }

  const expected = serverEnv.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    log.error('telegram.webhook.no_secret_configured');
    return signatureFailed('telegram');
  }

  const provided = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!safeStringEqual(provided, expected)) {
    log.warn('telegram.signature.invalid', { hasHeader: !!provided });
    return signatureFailed('telegram');
  }

  const raw = await readRawBody(req);
  let payload: unknown;
  try {
    payload = parseJsonFromBytes(raw);
  } catch (err) {
    log.warn('telegram.body.invalid_json', { err: (err as Error).message });
    return ack({ ignored: 'invalid_json' });
  }

  const parsed = telegramUpdate.safeParse(payload);
  if (!parsed.success) {
    log.warn('telegram.schema.mismatch', {
      issues: parsed.error.issues.slice(0, 5).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return ack({ ignored: 'schema_mismatch' });
  }

  // Phase 9 — process approval button taps before the ingest path skips them.
  if (parsed.data.callback_query) {
    try {
      const cb = parsed.data.callback_query as {
        id: string;
        from: { id: number; username?: string };
        data?: string;
        message?: { message_id: number; chat: { id: number } };
      };
      await handleTelegramCallback(cb);
      return ack({ callback: 'handled' });
    } catch (err) {
      log.error('telegram.callback.handler_failed', {
        err: (err as Error).message,
      });
      return ack({ callback: 'handler_failed' });
    }
  }

  // Phase 9 — process text commands before the ingest path.
  if (parsed.data.message?.text?.startsWith('/')) {
    try {
      const msg = parsed.data.message as {
        message_id: number;
        chat: { id: number };
        from: { id: number; username?: string };
        text: string;
      };
      await handleTelegramCommand(msg);
      return ack({ command: 'handled' });
    } catch (err) {
      log.error('telegram.command.handler_failed', {
        err: (err as Error).message,
      });
      return ack({ command: 'handler_failed' });
    }
  }

  try {
    const outcomes = await ingestTelegramUpdate(parsed.data);
    const inserted = outcomes.filter((o) => o.inserted).length;
    const skipped = outcomes.filter((o) => o.skipped).length;
    log.info('telegram.webhook.ingested', {
      updateId: parsed.data.update_id,
      total: outcomes.length,
      inserted,
      skipped,
    });
    return ack({ ingested: inserted, skipped });
  } catch (err) {
    log.error('telegram.webhook.ingest_failed', {
      err: (err as Error).message,
      stack: (err as Error).stack,
    });
    return ack({ error: 'ingest_failed' });
  }
}
