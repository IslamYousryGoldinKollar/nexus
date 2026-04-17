import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Gmail Pub/Sub push target — Phase 0 stub.
 *
 * Google Pub/Sub delivers JWT-signed POSTs containing a base64-encoded
 * notification envelope. Phase 1 will:
 *   1. Verify JWT against Google public keys.
 *   2. Decode `message.data` → Gmail historyId.
 *   3. Call Gmail API `users.history.list` with stored refresh token.
 *   4. Persist each new message as an `interaction`.
 */
export async function POST(req: NextRequest) {
  await req.json().catch(() => ({}));
  return NextResponse.json({ ok: true, phase: 0 });
}
