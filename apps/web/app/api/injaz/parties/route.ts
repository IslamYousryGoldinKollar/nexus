import { NextResponse } from 'next/server';
import { readSession } from '@/lib/auth/session';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { loadInjazClients } from '@/lib/injaz/lookups';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/injaz/parties — list Injaz CLIENT parties.
 *
 * Used by the contact-mapping dropdown. Cached 5 min in-process; pass
 * `?refresh=1` to bypass the cache after adding a new client in Injaz.
 */
export async function GET(req: Request) {
  const session = await readSession();
  if (!session || !isAllowedAdmin(session.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('refresh') === '1';

  try {
    const parties = await loadInjazClients(force);
    return NextResponse.json({
      parties: parties.map((p) => ({ name: p.name })),
    });
  } catch (err) {
    log.error('injaz.parties.failed', { err: (err as Error).message });
    return NextResponse.json({ error: 'lookup_failed' }, { status: 502 });
  }
}
