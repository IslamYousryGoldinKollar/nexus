import { NextResponse } from 'next/server';
import { readSession } from '@/lib/auth/session';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { loadInjazProjects } from '@/lib/injaz/lookups';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/injaz/projects — list ACTIVE Injaz projects, optionally
 * filtered to those linked to a specific client (?client=Blue%20Ocean).
 *
 * Injaz returns the literal em-dash `"—"` for projects without a
 * linked client; we surface those via the special filter `?client=__none__`.
 */
export async function GET(req: Request) {
  const session = await readSession();
  if (!session || !isAllowedAdmin(session.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('refresh') === '1';
  const clientFilter = url.searchParams.get('client');

  try {
    let projects = await loadInjazProjects(force);
    if (clientFilter) {
      const target = clientFilter === '__none__' ? '—' : clientFilter;
      projects = projects.filter((p) => p.client === target);
    }
    return NextResponse.json({
      projects: projects.map((p) => ({
        name: p.name,
        client: p.client === '—' ? null : p.client,
        status: p.status,
      })),
    });
  } catch (err) {
    log.error('injaz.projects.failed', { err: (err as Error).message });
    return NextResponse.json({ error: 'lookup_failed' }, { status: 502 });
  }
}
