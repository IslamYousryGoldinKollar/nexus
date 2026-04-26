import 'server-only';
import {
  desc,
  eq,
  getDb,
  proposedTasks,
  reasoningRuns,
  sessions,
  sql,
  inArray,
  and,
  type Database,
} from '@nexus/db';

export interface PastSessionSummary {
  sessionId: string;
  state: string;
  openedAt: Date;
  closedAt: Date | null;
  /** Whatever the AI summarised for that session, if anything */
  summary: string | null;
  proposedTitles: Array<{ title: string; state: string }>;
}

/**
 * Last N closed/approved sessions for a contact, with the proposed
 * tasks each one produced and what happened to them. Feeds the reasoner
 * so it knows the relationship history without re-reading every raw
 * interaction — much cheaper than dumping the full transcript.
 *
 * Excludes the current session (caller passes its id) so the AI doesn't
 * see itself in the prior-decisions block.
 */
export async function loadPastSessionsForContact(
  db: Database,
  contactId: string,
  excludeSessionId: string,
  limit = 5,
): Promise<PastSessionSummary[]> {
  const sess = await db
    .select({
      id: sessions.id,
      state: sessions.state,
      openedAt: sessions.openedAt,
      closedAt: sessions.closedAt,
      reasoningRunId: sessions.reasoningRunId,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.contactId, contactId),
        sql`${sessions.id} != ${excludeSessionId}`,
        sql`${sessions.state} in ('approved', 'rejected', 'closed', 'awaiting_approval')`,
      ),
    )
    .orderBy(desc(sessions.openedAt))
    .limit(limit);

  if (sess.length === 0) return [];

  const sessionIds = sess.map((s) => s.id);
  const runIds = sess.map((s) => s.reasoningRunId).filter((id): id is string => !!id);

  const [allTasks, allRuns] = await Promise.all([
    db
      .select({
        sessionId: proposedTasks.sessionId,
        title: proposedTasks.title,
        state: proposedTasks.state,
      })
      .from(proposedTasks)
      .where(inArray(proposedTasks.sessionId, sessionIds)),
    runIds.length
      ? db
          .select({
            id: reasoningRuns.id,
            rawResponse: reasoningRuns.rawResponse,
          })
          .from(reasoningRuns)
          .where(inArray(reasoningRuns.id, runIds))
      : Promise.resolve([] as Array<{ id: string; rawResponse: unknown }>),
  ]);

  const tasksBySession = new Map<string, Array<{ title: string; state: string }>>();
  for (const t of allTasks) {
    const list = tasksBySession.get(t.sessionId) ?? [];
    list.push({ title: t.title, state: t.state });
    tasksBySession.set(t.sessionId, list);
  }

  const summaryByRun = new Map<string, string>();
  for (const r of allRuns) {
    // Reasoning run rawResponse is the full OpenAI/Anthropic response; the
    // model often emits a `summary` field inside the JSON we parsed. We
    // didn't persist the parsed output as a separate column, so we
    // best-effort dig into the response shape we know about.
    const raw = r.rawResponse as
      | { choices?: Array<{ message?: { content?: string } }> }
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    let text: string | undefined;
    if (raw && 'choices' in raw && raw.choices?.[0]?.message?.content) {
      text = raw.choices[0].message.content;
    } else if (raw && 'content' in raw && Array.isArray(raw.content)) {
      const block = raw.content.find((b) => b.type === 'text');
      text = block?.text;
    }
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as { summary?: string };
      if (parsed.summary) summaryByRun.set(r.id, parsed.summary);
    } catch {
      /* ignore — model returned something we can't parse */
    }
  }

  return sess.map((s) => ({
    sessionId: s.id,
    state: s.state,
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    summary: s.reasoningRunId ? (summaryByRun.get(s.reasoningRunId) ?? null) : null,
    proposedTitles: tasksBySession.get(s.id) ?? [],
  }));
}

/** Convenience: invoke with the default db client. */
export async function loadPastSessionsForContactDefault(
  contactId: string,
  excludeSessionId: string,
  limit = 5,
): Promise<PastSessionSummary[]> {
  return loadPastSessionsForContact(getDb(), contactId, excludeSessionId, limit);
}
