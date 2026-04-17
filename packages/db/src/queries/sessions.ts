import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  interactions,
  sessions,
  type Interaction,
  type NewSession,
  type Session,
} from '../schema/sessions.js';

/**
 * Attach an interaction to a session.
 *
 * Rules (Phase 2):
 *   1. If an `open` session exists for this contact AND its
 *      `last_activity_at` is within `cooldownMinutes` of now → extend
 *      that session (update last_activity_at to max(session, interaction)).
 *   2. Otherwise open a new session.
 *
 * Closing the old session is the sweep cron's responsibility so that a
 * late-arriving interaction for a session that JUST expired still finds
 * it — we want to avoid racey premature closures.
 *
 * Idempotent: calling this twice for the same interaction is safe — the
 * second call updates the same session.
 */
export async function attachInteractionToSession(
  db: Database,
  args: {
    interactionId: string;
    contactId: string;
    occurredAt: Date;
    cooldownMinutes: number;
  },
): Promise<{ session: Session; newlyOpened: boolean }> {
  const { interactionId, contactId, occurredAt, cooldownMinutes } = args;

  return db.transaction(async (tx) => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - cooldownMinutes * 60 * 1000);

    // 1. Find latest open session for this contact.
    const [openSession] = await tx
      .select()
      .from(sessions)
      .where(and(eq(sessions.contactId, contactId), eq(sessions.state, 'open')))
      .orderBy(sql`${sessions.lastActivityAt} desc`)
      .limit(1);

    let session: Session;
    let newlyOpened = false;

    if (openSession && openSession.lastActivityAt >= cutoff) {
      // Extend.
      const nextActivity =
        occurredAt > openSession.lastActivityAt ? occurredAt : openSession.lastActivityAt;
      const [updated] = await tx
        .update(sessions)
        .set({ lastActivityAt: nextActivity, updatedAt: sql`now()` })
        .where(eq(sessions.id, openSession.id))
        .returning();
      if (!updated) throw new Error('session update returned no rows');
      session = updated;
    } else {
      if (openSession) {
        // Old session has gone stale — the sweep cron will close it later.
        // We deliberately leave it alone; attaching here could race with sweep.
      }
      const [created] = await tx
        .insert(sessions)
        .values({
          contactId,
          state: 'open',
          openedAt: occurredAt,
          lastActivityAt: occurredAt,
        } as NewSession)
        .returning();
      if (!created) throw new Error('session insert returned no rows');
      session = created;
      newlyOpened = true;
    }

    // Link the interaction.
    await tx
      .update(interactions)
      .set({ sessionId: session.id })
      .where(eq(interactions.id, interactionId));

    return { session, newlyOpened };
  });
}

/**
 * Transition a session from `open` to `aggregating` as it enters the
 * reasoning pipeline. Returns the updated row, or null if state had
 * already moved on (idempotency guard).
 */
export async function markSessionAggregating(
  db: Database,
  sessionId: string,
): Promise<Session | null> {
  const [updated] = await db
    .update(sessions)
    .set({ state: 'aggregating', updatedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.state, 'open')))
    .returning();
  return updated ?? null;
}

/** Transition aggregating → reasoning. */
export async function markSessionReasoning(
  db: Database,
  sessionId: string,
  trigger: Session['trigger'],
): Promise<Session | null> {
  const [updated] = await db
    .update(sessions)
    .set({ state: 'reasoning', trigger, updatedAt: sql`now()` })
    .where(
      and(
        eq(sessions.id, sessionId),
        sql`${sessions.state} in ('open','aggregating')`,
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Find all sessions that have been `open` for longer than `cooldownMinutes`.
 * Used by the sweep cron to trigger reasoning on stalled conversations.
 */
export async function findStaleOpenSessions(
  db: Database,
  cooldownMinutes: number,
  limit = 100,
): Promise<Session[]> {
  const cutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000);
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.state, 'open'),
        lt(sessions.lastActivityAt, cutoff),
        isNull(sessions.closedAt),
      ),
    )
    .orderBy(sessions.lastActivityAt)
    .limit(limit);
}

/** Count interactions in a session — used by the Phase 4 reasoner. */
export async function countSessionInteractions(
  db: Database,
  sessionId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(interactions)
    .where(eq(interactions.sessionId, sessionId));
  return rows[0]?.count ?? 0;
}

/**
 * Fetch the session's interactions in chronological order.
 * Used for context bundling in the reasoning phase.
 */
export async function getSessionInteractions(
  db: Database,
  sessionId: string,
): Promise<Interaction[]> {
  return db
    .select()
    .from(interactions)
    .where(eq(interactions.sessionId, sessionId))
    .orderBy(interactions.occurredAt);
}
