import { type NextRequest, NextResponse } from 'next/server';
import { getDb, sessions, sql } from '@nexus/db';
import { inngest } from '@/lib/inngest';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron: every 10 minutes, kick reasoning on any session that has
 * been silent for more than `SESSION_COOLDOWN_MIN` (default 120).
 *
 * Why a cron instead of relying on the Inngest `onSessionCooldown`
 * function: Inngest's `step.sleep` chain has been flaky on this project
 * (events get queued but the function doesn't always wake on schedule).
 * This cron is a belt-and-suspenders safety net so reasoning fires even
 * if Inngest mis-routes its own internal events.
 *
 * Auth: Vercel sets `Authorization: Bearer <CRON_SECRET>` automatically
 * for cron-triggered invocations when CRON_SECRET is configured. We
 * verify, then move every cool-down-eligible session to `reasoning`
 * state and emit `nexus/session.reasoning.requested`.
 *
 * Configured in /vercel.json.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    // Vercel Cron Job auth check.
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authz = req.headers.get('authorization') ?? '';
      if (authz !== `Bearer ${cronSecret}`) {
        log.warn('cron.auto-reason.unauthorized');
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const cooldownMin = Number(process.env.SESSION_COOLDOWN_MIN ?? '120') || 120;
    const cutoffMs = Date.now() - cooldownMin * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    const db = getDb();

    // Atomic: flip eligible sessions to `reasoning` AND get back the ids.
    // Status filter matches the state machine: only `open` and
    // `aggregating` should be promoted; sessions already past that
    // (reasoning / awaiting_approval / closed / error) are left alone.
    const promoted = await db
      .update(sessions)
      .set({ state: 'reasoning', updatedAt: sql`now()` })
      .where(
        sql`${sessions.state} in ('open', 'aggregating') and ${sessions.lastActivityAt} <= ${cutoffIso}`,
      )
      .returning({ id: sessions.id });

    if (promoted.length === 0) {
      log.info('cron.auto-reason.no_eligible_sessions', { cooldownMin });
      return NextResponse.json({ ok: true, promoted: 0 });
    }

    log.info('cron.auto-reason.promoted', { count: promoted.length, cooldownMin });

    // Fan out reasoning events. Inngest can pick these up if it's
    // healthy; if not, the next cron tick will see the sessions stuck
    // in `reasoning` state — at which point a follow-up cron (or the
    // /api/admin/direct-reasoning endpoint) can drive them through.
    const events = promoted.map((s) => ({
      name: 'nexus/session.reasoning.requested' as const,
      data: { sessionId: s.id, trigger: 'silence_timeout' as const },
    }));
    try {
      const result = await inngest.send(events);
      log.info('cron.auto-reason.events_sent', {
        count: events.length,
        eventIds: result.ids?.length ?? 0,
      });
    } catch (err) {
      log.error('cron.auto-reason.event_send_failed', { err: (err as Error).message });
      // Sessions are already in `reasoning` state. The follow-up
      // direct-reasoning fallback can still pick them up.
    }

    return NextResponse.json({
      ok: true,
      promoted: promoted.length,
      sessionIds: promoted.map((s) => s.id),
    });
  });
}
