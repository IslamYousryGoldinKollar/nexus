import { NextResponse } from 'next/server';
import { readSession } from '@/lib/auth/session';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { loadInjazUsers } from '@/lib/injaz/lookups';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/injaz/users — list approved Injaz users (employees).
 *
 * Used by the approval card's assignee dropdown. Filters out users
 * with approvalStatus !== 'approved' (those are stale duplicates).
 */
export async function GET(req: Request) {
  const session = await readSession();
  if (!session || !isAllowedAdmin(session.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('refresh') === '1';

  try {
    const users = await loadInjazUsers(force);
    return NextResponse.json({
      users: users.map((u) => ({ name: u.name, email: u.email, role: u.role })),
    });
  } catch (err) {
    log.error('injaz.users.failed', { err: (err as Error).message });
    return NextResponse.json({ error: 'lookup_failed' }, { status: 502 });
  }
}
