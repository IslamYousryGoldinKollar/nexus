import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * MS Teams ingest — Phase 0 stub.
 *
 * Phase 10 target is a Chrome extension that captures transcripts from
 * `teams.microsoft.com` and POSTs them here. Optional future path:
 * Microsoft Graph change-notification subscription for online meetings.
 *
 * Phase 1/10 will verify `TEAMS_INGEST_API_KEY` and persist one
 * `interaction` per meeting segment.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization');
  const expected = process.env.TEAMS_INGEST_API_KEY;
  if (expected) {
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (bearer !== expected) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }
  await req.json().catch(() => ({}));
  return NextResponse.json({ ok: true, phase: 0 });
}
