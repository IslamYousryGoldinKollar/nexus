import 'server-only';
import {
  contacts,
  costEvents,
  desc,
  eq,
  getDb,
  gte,
  inArray,
  interactions,
  pendingIdentifiers,
  proposedTasks,
  sessions,
  sql,
} from '@nexus/db';

/**
 * Dashboard queries — small, opinionated, fast.
 *
 * `loadDashboardSnapshot` fans out a handful of small COUNT and top-N
 * queries in parallel. No JOIN star-blast here; if a metric grows
 * complex we'll move it to a materialized view in Phase 11.
 */

export interface DashboardSnapshot {
  openSessions: number;
  awaitingApproval: number;
  pendingIdentifiers: number;
  proposedTasks24h: number;
  ingest24h: number;
  spend30d: { service: string; usd: number }[];
  recentSessions: Array<{
    id: string;
    contactName: string | null;
    state: string;
    lastActivityAt: Date;
    interactionCount: number;
  }>;
}

export async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  const db = getDb();
  const now = new Date();
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const month = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    openSessionsRow,
    awaitingApprovalRow,
    pendingIdentifiersRow,
    proposedTasks24hRow,
    ingest24hRow,
    spendByService,
    recentSessionsRows,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.state, 'open')),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.state, 'awaiting_approval')),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingIdentifiers)
      .where(eq(pendingIdentifiers.state, 'pending')),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(proposedTasks)
      .where(gte(proposedTasks.createdAt, day)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(interactions)
      .where(gte(interactions.occurredAt, day)),
    db
      .select({
        service: costEvents.service,
        total: sql<string>`coalesce(sum(${costEvents.costUsd}), 0)`,
      })
      .from(costEvents)
      .where(gte(costEvents.occurredAt, month))
      .groupBy(costEvents.service),
    db
      .select({
        id: sessions.id,
        contactId: sessions.contactId,
        state: sessions.state,
        lastActivityAt: sessions.lastActivityAt,
        contactName: contacts.displayName,
      })
      .from(sessions)
      .leftJoin(contacts, eq(contacts.id, sessions.contactId))
      .orderBy(desc(sessions.lastActivityAt))
      .limit(10),
  ]);

  // Batch interaction counts for the recent-sessions list.
  const sessionIds = recentSessionsRows.map((r) => r.id);
  const countsBySession = new Map<string, number>();
  if (sessionIds.length) {
    const counts = await db
      .select({
        sessionId: interactions.sessionId,
        count: sql<number>`count(*)::int`,
      })
      .from(interactions)
      .where(inArray(interactions.sessionId, sessionIds))
      .groupBy(interactions.sessionId);
    for (const r of counts) {
      if (r.sessionId) countsBySession.set(r.sessionId, r.count);
    }
  }

  return {
    openSessions: openSessionsRow[0]?.count ?? 0,
    awaitingApproval: awaitingApprovalRow[0]?.count ?? 0,
    pendingIdentifiers: pendingIdentifiersRow[0]?.count ?? 0,
    proposedTasks24h: proposedTasks24hRow[0]?.count ?? 0,
    ingest24h: ingest24hRow[0]?.count ?? 0,
    spend30d: spendByService.map((r) => ({
      service: r.service,
      usd: Number(r.total),
    })),
    recentSessions: recentSessionsRows.map((r) => ({
      id: r.id,
      contactName: r.contactName,
      state: r.state,
      lastActivityAt: r.lastActivityAt,
      interactionCount: countsBySession.get(r.id) ?? 0,
    })),
  };
}
