import {
  findStaleOpenSessions,
  getDb,
  markSessionAggregating,
  markSessionReasoning,
} from '@nexus/db';
import { inngest } from '../client.js';

/**
 * Debounced session-cooldown handler.
 *
 * Inngest `debounce` resets the timer every time a new event with the
 * same `key` arrives, so a chatty session keeps pushing the reasoning
 * trigger out. After `SESSION_COOLDOWN_MIN` minutes of silence the
 * function runs once and emits `session.reasoning.requested`.
 *
 * We check the session state inside the step because the debounce
 * window can race with Phase 4 marking it aggregating/reasoning manually.
 */
export const onSessionCooldown = inngest.createFunction(
  {
    id: 'session-cooldown',
    name: 'Debounced session cooldown (Phase 2)',
    debounce: {
      // Dynamic period via Inngest env-substitution at deploy time.
      period: `${Number(process.env.SESSION_COOLDOWN_MIN ?? '120') || 120}m`,
      key: 'event.data.sessionId',
    },
  },
  { event: 'nexus/session.cooldown.heartbeat' },
  async ({ event, step, logger }) => {
    const { sessionId } = event.data;

    const marked = await step.run('transition-aggregating', async () => {
      const db = getDb();
      const session = await markSessionAggregating(db, sessionId);
      if (!session) return null;
      const reasoning = await markSessionReasoning(db, sessionId, 'silence_timeout');
      return reasoning;
    });

    if (!marked) {
      logger.info('cooldown.skipped', { sessionId, reason: 'state_advanced' });
      return { status: 'skipped' as const };
    }

    await step.sendEvent('emit-reasoning', {
      name: 'nexus/session.reasoning.requested',
      data: { sessionId, trigger: 'silence_timeout' },
    });

    return { status: 'reasoning-emitted' as const, sessionId };
  },
);

/**
 * Belt-and-suspenders cron sweep.
 *
 * Runs on `SESSION_SWEEP_CRON` (default every 2 hours) and flushes any
 * `open` sessions that somehow escaped the debounce (queue outage,
 * missed event, etc.). Idempotent — `markSessionReasoning` is a no-op
 * on sessions already past `open/aggregating`.
 */
export const sessionSweep = inngest.createFunction(
  { id: 'session-sweep', name: 'Hourly session sweep (Phase 2)' },
  { cron: process.env.SESSION_SWEEP_CRON ?? '0 */2 * * *' },
  async ({ step, logger }) => {
    const cooldownMin = Number(process.env.SESSION_COOLDOWN_MIN ?? '120') || 120;

    const stale = await step.run('find-stale', async () => {
      const db = getDb();
      return findStaleOpenSessions(db, cooldownMin, 200);
    });

    logger.info('sweep.found', { count: stale.length, cooldownMin });

    if (stale.length === 0) return { count: 0 };

    // We fan out via Inngest events instead of handling in-loop so each
    // session gets its own retry/timeout/observability.
    await step.sendEvent(
      'fanout',
      stale.map((s) => ({
        name: 'nexus/session.reasoning.requested' as const,
        data: { sessionId: s.id, trigger: 'cron' as const },
      })),
    );

    return { count: stale.length };
  },
);
