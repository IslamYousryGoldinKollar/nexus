import 'server-only';
import {
  eq,
  insertProposedTasks,
  insertReasoningRun,
  loadSessionContext,
  recordCostEvent,
  sessions as sessionsTable,
  sql,
  type Database,
} from '@nexus/db';
import { reasonOverSession, GPT_4O_MINI } from '@nexus/services';
import { log } from '@/lib/logger';
import { notifyProposalCreated } from '@/lib/notify/proposal';

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
  const model = process.env.OPENAI_MODEL?.trim() || GPT_4O_MINI;

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
