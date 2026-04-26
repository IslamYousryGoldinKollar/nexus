import { type NextRequest, NextResponse } from 'next/server';
import { getDb, sessions as sessionsTable, sql } from '@nexus/db';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { runReasoningForSession } from '@/lib/reasoning/run-for-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * @deprecated TEMPORARY workaround for an Inngest pipeline issue
 * (suspected env-var newline corruption — fixed in commit `d420e9a`).
 * Slated for removal once `nexus/session.reasoning.requested` events
 * deliver end-to-end in prod. See `docs/runbook.md` § "Debug endpoints
 * (temporary)".
 *
 * Direct reasoning endpoint — bypasses Inngest, runs GPT-4o-mini (OpenAI)
 * over a session immediately. Now delegates to `runReasoningForSession`
 * which is also used by the auto-reason cron, so behavior is identical.
 *
 * GET /api/admin/direct-reasoning?sessionId=<uuid>
 * GET /api/admin/direct-reasoning?all=true
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('admin.direct-reasoning.rate_limited');
      return NextResponse.json(
        { error: 'Rate limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }

    const adminKey = process.env.ADMIN_API_KEY?.trim();
    const providedKey = (
      req.headers.get('x-admin-key') ||
      req.nextUrl.searchParams.get('key') ||
      ''
    ).trim();

    if (!adminKey || providedKey !== adminKey) {
      log.warn('admin.direct-reasoning.unauthorized');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const sessionId = req.nextUrl.searchParams.get('sessionId');
    const all = req.nextUrl.searchParams.get('all') === 'true';

    const db = getDb();

    let targetSessionIds: string[] = [];
    if (sessionId) {
      targetSessionIds = [sessionId];
    } else if (all) {
      const openOrReasoning = await db
        .select({ id: sessionsTable.id })
        .from(sessionsTable)
        .where(sql`state IN ('open', 'reasoning', 'aggregating')`)
        .limit(10);
      targetSessionIds = openOrReasoning.map((s) => s.id);
    } else {
      return NextResponse.json(
        { error: 'Must provide sessionId or all=true' },
        { status: 400 },
      );
    }

    const results = [];
    for (const sid of targetSessionIds) {
      const status = await runReasoningForSession(db, sid);
      results.push({ sessionId: sid, ...status });
    }

    log.info('admin.direct-reasoning.completed', {
      processed: results.length,
      successful: results.filter((r) => r.status === 'completed').length,
    });

    return NextResponse.json({
      processed: results.length,
      successful: results.filter((r) => r.status === 'completed').length,
      results,
    });
  });
}
