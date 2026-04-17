import { NextResponse } from 'next/server';

/**
 * Common webhook response helpers.
 *
 * Meta/WhatsApp, Telegram, and Google Pub/Sub all redeliver on non-2xx
 * responses. Keep happy paths as plain 200 with a tiny JSON ack so we
 * get a predictable server-log line and avoid redundant retries.
 */

export function ack(data: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...data }, { status: 200 });
}

export function badRequest(reason: string, details?: unknown) {
  return NextResponse.json(
    { ok: false, error: 'bad_request', reason, ...(details ? { details } : {}) },
    { status: 400 },
  );
}

/**
 * Signature verification failure. We deliberately return 200 so the sender
 * does not keep retrying a forged/corrupt delivery forever; the event is
 * noted in server logs for audit.
 *
 * Meta's docs say: "respond with 200 OK to acknowledge the webhook".
 * Even for bad signatures we swallow — otherwise a bad secret config
 * becomes a retry storm.
 */
export function signatureFailed(channel: string) {
  return NextResponse.json(
    { ok: false, error: 'signature_verification_failed', channel },
    { status: 200 },
  );
}

export function unauthorized() {
  return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

export function forbidden(reason: string) {
  return NextResponse.json({ ok: false, error: 'forbidden', reason }, { status: 403 });
}

export function serverError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json(
    { ok: false, error: 'internal_error', message },
    { status: 500 },
  );
}
