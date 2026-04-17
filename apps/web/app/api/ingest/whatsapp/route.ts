import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * WhatsApp Cloud API webhook — Phase 0 stub.
 *
 * GET: Meta's subscription-verification handshake.
 *   → expects `hub.mode=subscribe` + `hub.verify_token=${WHATSAPP_VERIFY_TOKEN}`
 *   → returns `hub.challenge` verbatim on success.
 *
 * POST: incoming message notifications.
 *   Phase 1 will: verify HMAC signature, persist to `interactions`,
 *   enqueue `nexus/interaction.ingested`. For Phase 0 we ACK with 200.
 */

export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === 'subscribe' && token && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(req: NextRequest) {
  // Phase 1 will verify X-Hub-Signature-256 here before reading the body.
  // For Phase 0 we only acknowledge — Meta retries on non-200s, so this
  // silently accepts until we flesh it out.
  await req.json().catch(() => ({}));
  return NextResponse.json({ ok: true, phase: 0 });
}
