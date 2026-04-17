import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Telegram Bot API webhook — Phase 0 stub.
 *
 * Dual purpose:
 *   (a) ingesting messages a client sends us via Telegram (channel=telegram).
 *   (b) delivering admin-group actions (approve/reject button callbacks).
 *
 * Phase 1 will verify the `X-Telegram-Bot-Api-Secret-Token` header against
 * TELEGRAM_WEBHOOK_SECRET and fan out to grammY handlers.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && secret !== expected) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  await req.json().catch(() => ({}));
  return NextResponse.json({ ok: true, phase: 0 });
}
