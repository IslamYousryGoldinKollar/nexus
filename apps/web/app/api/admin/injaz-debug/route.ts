import { NextResponse, type NextRequest } from 'next/server';
import {
  injazClientFromEnv,
  listInjazParties,
  listInjazUsers,
  listInjazProjects,
  callInjazMcpToolRaw,
} from '@nexus/services';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * @deprecated TEMPORARY: surfaces the result of the three Injaz MCP
 * lookups so we can debug why the contact-mapping dropdowns are empty
 * in production. Pass `?raw=list_parties` (or any tool name) to bypass
 * the parser and see the actual MCP envelope.
 *
 * GET /api/admin/injaz-debug?key=<ADMIN_API_KEY>
 * GET /api/admin/injaz-debug?key=...&raw=list_parties
 */
export async function GET(req: NextRequest) {
  const adminKey = process.env.ADMIN_API_KEY?.trim();
  const provided = (
    req.headers.get('x-admin-key') ||
    req.nextUrl.searchParams.get('key') ||
    ''
  ).trim();
  if (!adminKey || provided !== adminKey) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const env = {
    INJAZ_API_BASE: process.env.INJAZ_API_BASE ? 'set' : 'unset',
    INJAZ_API_KEY: process.env.INJAZ_API_KEY ? 'set' : 'unset',
    INJAZ_MCP_URL: process.env.INJAZ_MCP_URL ? 'set' : 'unset',
  };

  const client = injazClientFromEnv();
  if (!client) {
    return NextResponse.json({ ok: false, env, error: 'injazClientFromEnv returned null' });
  }

  // ?raw=list_parties → return the raw MCP response envelope so we
  // can see what shape Injaz actually returns and update the parser.
  const rawTool = req.nextUrl.searchParams.get('raw');
  if (rawTool) {
    const argsStr = req.nextUrl.searchParams.get('args') ?? '{}';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsStr);
    } catch {
      return NextResponse.json({ error: 'args must be valid JSON' }, { status: 400 });
    }
    try {
      const raw = await callInjazMcpToolRaw(client, rawTool, args);
      return NextResponse.json({ ok: true, env, tool: rawTool, args, raw });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        env,
        tool: rawTool,
        args,
        error: (err as Error).message,
      });
    }
  }

  const out: Record<string, unknown> = { ok: true, env };
  try {
    const parties = await listInjazParties(client, 'CLIENT');
    out.parties = { count: parties.length, sample: parties.slice(0, 3) };
  } catch (err) {
    out.partiesError = (err as Error).message;
    log.error('injaz-debug.parties_failed', { err: (err as Error).message });
  }
  try {
    const users = await listInjazUsers(client);
    out.users = { count: users.length, sample: users.slice(0, 3) };
  } catch (err) {
    out.usersError = (err as Error).message;
  }
  try {
    const projects = await listInjazProjects(client, 'ACTIVE');
    out.projects = { count: projects.length, sample: projects.slice(0, 3) };
  } catch (err) {
    out.projectsError = (err as Error).message;
  }
  return NextResponse.json(out);
}
