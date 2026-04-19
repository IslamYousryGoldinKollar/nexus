import 'server-only';
import {
  asc,
  contacts,
  desc,
  eq,
  getDb,
  inArray,
  proposedTasks,
  reasoningRuns,
  sessions,
  type ProposedTask,
  type ReasoningRun,
  type Session,
} from '@nexus/db';

/**
 * Approvals queue: every session in `awaiting_approval` along with its
 * proposed tasks. Card-style list — small enough that loading the full
 * task array per row is cheap.
 */

export interface ApprovalCard {
  session: Session;
  contactName: string | null;
  reasoningRun: ReasoningRun | null;
  tasks: ProposedTask[];
}

export async function loadAwaitingApprovals(limit = 50): Promise<ApprovalCard[]> {
  const db = getDb();

  const sess = await db
    .select({
      session: sessions,
      contactName: contacts.displayName,
    })
    .from(sessions)
    .leftJoin(contacts, eq(contacts.id, sessions.contactId))
    .where(eq(sessions.state, 'awaiting_approval'))
    .orderBy(desc(sessions.lastActivityAt))
    .limit(limit);

  if (sess.length === 0) return [];

  const sessionIds = sess.map((s) => s.session.id);
  const reasoningRunIds = sess
    .map((s) => s.session.reasoningRunId)
    .filter((id): id is string => !!id);

  const [allTasks, allRuns] = await Promise.all([
    db
      .select()
      .from(proposedTasks)
      .where(inArray(proposedTasks.sessionId, sessionIds))
      .orderBy(asc(proposedTasks.createdAt)),
    reasoningRunIds.length
      ? db.select().from(reasoningRuns).where(inArray(reasoningRuns.id, reasoningRunIds))
      : Promise.resolve([] as ReasoningRun[]),
  ]);

  const tasksBySession = new Map<string, ProposedTask[]>();
  for (const t of allTasks) {
    const list = tasksBySession.get(t.sessionId) ?? [];
    list.push(t);
    tasksBySession.set(t.sessionId, list);
  }

  const runById = new Map<string, ReasoningRun>();
  for (const r of allRuns) runById.set(r.id, r);

  return sess.map((s) => ({
    session: s.session,
    contactName: s.contactName,
    reasoningRun: s.session.reasoningRunId
      ? (runById.get(s.session.reasoningRunId) ?? null)
      : null,
    tasks: tasksBySession.get(s.session.id) ?? [],
  }));
}
