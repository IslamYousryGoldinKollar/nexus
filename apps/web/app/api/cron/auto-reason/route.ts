import { type NextRequest, NextResponse } from 'next/server';
import { getDb, sessions, sql } from '@nexus/db';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';
import { runReasoningForSession } from '@/lib/reasoning/run-for-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Reasoning over up to 8 sessions × ~3s each + Telegram fan-out.
export const maxDuration = 120;

/**
 * Vercel Cron: every 2 minutes, find sessions that have been silent for
 * more than `SESSION_COOLDOWN_MIN` (default 5 minutes), promote them to
 * `reasoning`, run GPT inline, persist proposed tasks, and fire a
 * Telegram notification when tasks were created.
 *
 * Replaces the old auto-reason → Inngest event hand-off, which was
 * unreliable on this project. Doing it inline means the WhatsApp →
 * Telegram-approval round trip is bounded by the cron schedule (≤ 2 min
 * + cooldown), not by Inngest queue health.
 *
 * Configured in /apps/web/vercel.json.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authz = req.headers.get('authorization') ?? '';
      if (authz !== `Bearer ${cronSecret}`) {
        log.warn('cron.auto-reason.unauthorized');
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const cooldownMin = Number(process.env.SESSION_COOLDOWN_MIN ?? '5') || 5;
    const cutoffMs = Date.now() - cooldownMin * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    const db = getDb();

    // Atomic flip: pick eligible sessions and bump them to `reasoning`
    // in one statement so concurrent cron invocations don't double-fire
    // on the same session.
    const promoted = await db
      .update(sessions)
      .set({ state: 'reasoning', updatedAt: sql`now()` })
      .where(
        sql`${sessions.state} in ('open', 'aggregating') and ${sessions.lastActivityAt} <= ${cutoffIso}`,
      )
      .returning({ id: sessions.id });

    if (promoted.length === 0) {
      log.info('cron.auto-reason.no_eligible_sessions', { cooldownMin });
      return NextResponse.json({ ok: true, promoted: 0, reasoned: 0 });
    }

    log.info('cron.auto-reason.promoted', { count: promoted.length, cooldownMin });

    // Cap per-tick work so a single invocation always finishes inside
    // maxDuration. Anything we don't get to stays in `reasoning` state
    // and the next /api/admin/direct-reasoning?all=true (or this cron's
    // next tick if we widen the filter) will pick it up.
    const batch = promoted.slice(0, 8);

    const results = [];
    for (const { id } of batch) {
      const status = await runReasoningForSession(db, id);
      results.push({ sessionId: id, ...status });
    }

    const successful = results.filter((r) => r.status === 'completed').length;
    const tasksCreated = results.reduce(
      (acc, r) => acc + (r.status === 'completed' ? r.taskCount : 0),
      0,
    );

    return NextResponse.json({
      ok: true,
      promoted: promoted.length,
      reasoned: results.length,
      successful,
      tasksCreated,
      results,
    });
  });
}
