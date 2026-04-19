import 'server-only';
import {
  contacts,
  desc,
  eq,
  getDb,
  inArray,
  interactions,
  loadSessionContext,
  sessions,
  sql,
  type SessionContext,
} from '@nexus/db';

export interface SessionListRow {
  id: string;
  state: string;
  contactName: string | null;
  contactId: string | null;
  openedAt: Date;
  lastActivityAt: Date;
  closedAt: Date | null;
  interactionCount: number;
}

export async function listSessions(opts: {
  state?: 'open' | 'awaiting_approval' | 'approved' | 'rejected' | 'synced' | 'closed' | 'error';
  limit?: number;
}): Promise<SessionListRow[]> {
  const db = getDb();
  const limit = opts.limit ?? 100;

  const rows = await db
    .select({
      id: sessions.id,
      state: sessions.state,
      contactId: sessions.contactId,
      openedAt: sessions.openedAt,
      lastActivityAt: sessions.lastActivityAt,
      closedAt: sessions.closedAt,
      contactName: contacts.displayName,
    })
    .from(sessions)
    .leftJoin(contacts, eq(contacts.id, sessions.contactId))
    .where(opts.state ? eq(sessions.state, opts.state) : undefined)
    .orderBy(desc(sessions.lastActivityAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const sessionIds = rows.map((r) => r.id);
  const counts = await db
    .select({
      sessionId: interactions.sessionId,
      count: sql<number>`count(*)::int`,
    })
    .from(interactions)
    .where(inArray(interactions.sessionId, sessionIds))
    .groupBy(interactions.sessionId);

  const countsBySession = new Map<string, number>();
  for (const r of counts) {
    if (r.sessionId) countsBySession.set(r.sessionId, r.count);
  }

  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    contactName: r.contactName,
    contactId: r.contactId,
    openedAt: r.openedAt,
    lastActivityAt: r.lastActivityAt,
    closedAt: r.closedAt,
    interactionCount: countsBySession.get(r.id) ?? 0,
  }));
}

export async function getSessionDetail(sessionId: string): Promise<SessionContext | null> {
  const db = getDb();
  return loadSessionContext(db, sessionId);
}
