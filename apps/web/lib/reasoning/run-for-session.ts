import 'server-only';
import {
  contacts,
  eq,
  insertProposedTasks,
  insertReasoningRun,
  loadSessionContext,
  recordCostEvent,
  sessions as sessionsTable,
  sql,
  type Database,
} from '@nexus/db';
import {
  reasonOverSession,
  DEFAULT_REASONING_MODEL,
  listOpenInjazTasksForClient,
  listInjazProjectsForClient,
  listInjazAssigneeWorkload,
} from '@nexus/services';
import { log } from '@/lib/logger';
import { notifyProposalCreated } from '@/lib/notify/proposal';
import { loadPastSessionsForContact } from '@/lib/queries/contact-history';

export type RunReasoningStatus =
  | { status: 'completed'; reasoningRunId: string; taskCount: number; nextState: 'awaiting_approval' | 'closed'; costUsd: number; latencyMs: number; firstTaskId: string | null }
  | { status: 'not_found' }
  | { status: 'empty' }
  | { status: 'no_api_key' }
  | { status: 'error'; error: string };

/**
 * Run GPT reasoning for one session inline. Shared by:
 *   - /api/cron/auto-reason (10 min cron)
 *   - /api/admin/direct-reasoning (manual)
 *
 * Returns a status object instead of throwing — callers loop over many
 * sessions and need to keep going if one blows up.
 *
 * Side effects:
 *   - Inserts reasoning_runs + proposed_tasks rows.
 *   - Transitions session.state to 'awaiting_approval' (tasks > 0) or 'closed'.
 *   - Records cost_event.
 *   - Fires Telegram notification when tasks were created (best-effort).
 */
export async function runReasoningForSession(
  db: Database,
  sessionId: string,
): Promise<RunReasoningStatus> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    log.error('reasoning.no_api_key', { sessionId });
    return { status: 'no_api_key' };
  }
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_REASONING_MODEL;

  try {
    const ctx = await loadSessionContext(db, sessionId);
    if (!ctx) {
      log.warn('reasoning.session_not_found', { sessionId });
      return { status: 'not_found' };
    }

    if (ctx.interactions.length === 0) {
      await db
        .update(sessionsTable)
        .set({ state: 'closed', closedAt: new Date(), updatedAt: sql`now()` })
        .where(eq(sessionsTable.id, sessionId));
      log.info('reasoning.session_empty', { sessionId });
      return { status: 'empty' };
    }

    const toIso = (v: Date | string): string =>
      typeof v === 'string' ? v : v.toISOString();

    // Pull the contact's Injaz mapping so we can fetch open tasks
    // already on the board for that client. Without this the AI has
    // no way to know "this is an update to existing work" vs "new
    // task" and we get duplicates every meeting.
    let injazPartyName: string | null = null;
    let injazProjectName: string | null = null;
    if (ctx.contact?.id) {
      const [row] = await db
        .select({
          partyName: contacts.injazPartyName,
          projectName: contacts.injazProjectName,
        })
        .from(contacts)
        .where(eq(contacts.id, ctx.contact.id))
        .limit(1);
      injazPartyName = row?.partyName ?? null;
      injazProjectName = row?.projectName ?? null;
    }
    // Pull all the Injaz-side context the AI needs in parallel — every
    // call is independent and adds up to ~1-2s sequentially. Failures
    // are logged but don't block reasoning; an empty array just means
    // the AI sees no extra context for that dimension.
    const [
      existingInjazTasks,
      clientProjects,
      assigneeWorkload,
      pastSessions,
    ] = await Promise.all([
      injazPartyName || injazProjectName
        ? listOpenInjazTasksForClient({
            clientName: injazPartyName,
            projectName: injazProjectName,
            limit: 25,
          }).catch((err) => {
            log.warn('reasoning.injaz_tasks_failed', { sessionId, err: (err as Error).message });
            return [];
          })
        : Promise.resolve([]),
      injazPartyName
        ? listInjazProjectsForClient(injazPartyName).catch((err) => {
            log.warn('reasoning.injaz_projects_failed', { sessionId, err: (err as Error).message });
            return [];
          })
        : Promise.resolve([]),
      listInjazAssigneeWorkload().catch((err) => {
        log.warn('reasoning.injaz_workload_failed', { sessionId, err: (err as Error).message });
        return [];
      }),
      ctx.contact?.id
        ? loadPastSessionsForContact(db, ctx.contact.id, sessionId, 5).catch((err) => {
            log.warn('reasoning.past_sessions_failed', { sessionId, err: (err as Error).message });
            return [];
          })
        : Promise.resolve([]),
    ]);

    const reasonInput = {
      sessionId,
      openedAt: toIso(ctx.session.openedAt),
      lastActivityAt: toIso(ctx.session.lastActivityAt),
      contact: ctx.contact
        ? {
            id: ctx.contact.id,
            displayName: ctx.contact.displayName,
            notes: ctx.contact.notes,
            identifiers: ctx.identifiers.map((i) => ({ kind: i.kind, value: i.value })),
          }
        : null,
      account: ctx.account
        ? { id: ctx.account.id, name: ctx.account.name, domain: ctx.account.domain }
        : null,
      interactions: ctx.interactions.map(({ interaction, transcripts: tr }) => ({
        id: interaction.id,
        channel: interaction.channel,
        direction: interaction.direction,
        contentType: interaction.contentType,
        occurredAt: toIso(interaction.occurredAt),
        text: interaction.text,
        transcriptText: tr.length > 0 ? tr.map((t) => t.text).join('\n\n') : null,
      })),
      existingInjazTasks: existingInjazTasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate ? toIso(t.dueDate) : null,
        assigneeName: t.assigneeName,
        projectName: t.projectName,
      })),
      clientProjects: clientProjects.map((p) => ({
        name: p.name,
        openTaskCount: p.openTaskCount,
        description: p.description,
      })),
      assigneeWorkload: assigneeWorkload.map((w) => ({
        name: w.name,
        openTasks: w.openTasks,
      })),
      pastSessions: pastSessions.map((s) => ({
        openedAt: toIso(s.openedAt),
        state: s.state,
        summary: s.summary,
        proposedTitles: s.proposedTitles,
      })),
    };

    const result = await reasonOverSession({
      apiKey,
      model,
      context: reasonInput,
      provider: 'openai',
    });

    const run = await insertReasoningRun(db, {
      sessionId,
      model,
      systemPrompt: 'NEXUS_PERSONA + OUTPUT_CONTRACT (v1)',
      contextBundle: reasonInput as unknown as Record<string, unknown>,
      rawResponse: result.rawResponse as unknown as Record<string, unknown>,
      costUsd: result.costUsd.toFixed(6),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
    });

    // Validate `existingInjazTaskId` against the tasks we actually showed
    // the model — block hallucinated ids. Anything unrecognized falls
    // back to "create new" so we don't try to PATCH a non-existent task.
    const knownInjazIds = new Set(existingInjazTasks.map((t) => t.id));
    const tasks = await insertProposedTasks(
      db,
      result.output.proposedTasks.map((t) => ({
        sessionId,
        reasoningRunId: run.id,
        title: t.title,
        description: t.description,
        assigneeGuess: t.assigneeGuess ?? null,
        priorityGuess: t.priority,
        dueDateGuess: t.dueDateGuess ? new Date(t.dueDateGuess) : null,
        injazExistingTaskId:
          t.existingInjazTaskId && knownInjazIds.has(t.existingInjazTaskId)
            ? t.existingInjazTaskId
            : null,
        rationale: t.rationale,
        evidence: t.evidence.map((e) => ({
          interactionId: e.interactionId,
          quote: e.quote,
        })),
        state: 'proposed' as const,
      })),
    );

    await recordCostEvent(db, {
      service: 'openai',
      operation: 'reason.session',
      costUsd: result.costUsd.toFixed(6),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      sessionId,
      metadata: {
        reasoningRunId: run.id,
        model,
        latencyMs: result.latencyMs,
        tasksProduced: tasks.length,
      },
    });

    const nextState: 'awaiting_approval' | 'closed' = tasks.length > 0 ? 'awaiting_approval' : 'closed';
    await db
      .update(sessionsTable)
      .set({
        state: nextState,
        reasoningRunId: run.id,
        closedAt: nextState === 'closed' ? new Date() : null,
        updatedAt: sql`now()`,
      })
      .where(eq(sessionsTable.id, sessionId));

    const firstTaskId = tasks[0]?.id ?? null;

    // Best-effort Telegram notification — don't let a Telegram outage
    // prevent the reasoning result from persisting.
    if (tasks.length > 0) {
      try {
        await notifyProposalCreated(db, {
          sessionId,
          proposedTaskIds: tasks.map((t) => t.id),
        });
      } catch (err) {
        log.error('reasoning.notify_failed', {
          sessionId,
          err: (err as Error).message,
        });
      }
    }

    log.info('reasoning.session_completed', {
      sessionId,
      taskCount: tasks.length,
      nextState,
    });

    return {
      status: 'completed',
      reasoningRunId: run.id,
      taskCount: tasks.length,
      nextState,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      firstTaskId,
    };
  } catch (err) {
    log.error('reasoning.session_failed', {
      sessionId,
      err: (err as Error).message,
    });
    return { status: 'error', error: (err as Error).message };
  }
}
