import {
  contacts,
  eq,
  getDb,
  insertProposedTasks,
  insertReasoningRun,
  isOverMonthlyBudget,
  loadSessionContext,
  recordCostEvent,
  sessions as sessionsTable,
  sql,
} from '@nexus/db';
import { reasonOverSession, GPT_4O_MINI } from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Phase 4 — Reason over a session with GPT-4o-mini (OpenAI).
 *
 * Trigger: `nexus/session.reasoning.requested`
 * Preconditions: the session is in state `reasoning` (Phase 2 transitions it).
 *
 * Outputs: a `reasoning_runs` row, 0..N `proposed_tasks` rows, a
 * `cost_events` row, and a `nexus/proposal.created` event. The session
 * state advances to `awaiting_approval` iff any tasks were produced,
 * else `closed` (no follow-ups needed).
 */
export const reasonSession = inngest.createFunction(
  {
    id: 'session-reason',
    name: 'Reason over session with OpenAI (Phase 4)',
    retries: 1,
    concurrency: { limit: 3 },
  },
  { event: 'nexus/session.reasoning.requested' },
  async ({ event, step, logger }) => {
    const { sessionId } = event.data;

    // ---- 1. Load session context ----------------------------------------
    const ctx = await step.run('load-context', async () => {
      const db = getDb();
      return loadSessionContext(db, sessionId);
    });
    if (!ctx) {
      logger.warn('reason.session_not_found', { sessionId });
      return { status: 'no-session' as const };
    }
    if (ctx.interactions.length === 0) {
      logger.info('reason.empty_session', { sessionId });
      await step.run('close-empty', async () => {
        const db = getDb();
        await db
          .update(sessionsTable)
          .set({ state: 'closed', closedAt: new Date(), updatedAt: sql`now()` })
          .where(eq(sessionsTable.id, sessionId));
      });
      return { status: 'empty' as const };
    }

    // ---- 2. Privacy check: contact action permission --------------------
    if (ctx.contact) {
      const contact = await step.run('check-contact-permission', async () => {
        const db = getDb();
        const [row] = await db
          .select()
          .from(contacts)
          .where(eq(contacts.id, ctx.contact!.id))
          .limit(1);
        return row ?? null;
      });
      if (contact && !contact.allowAction) {
        logger.info('reason.skip.contact_blocked', {
          sessionId,
          contactId: contact.id,
        });
        await step.run('close-blocked', async () => {
          const db = getDb();
          await db
            .update(sessionsTable)
            .set({ state: 'closed', closedAt: new Date(), updatedAt: sql`now()` })
            .where(eq(sessionsTable.id, sessionId));
        });
        return { status: 'contact-blocked' as const, contactId: contact.id };
      }
    }

    // ---- 2. Budget circuit-breaker --------------------------------------
    const apiKey = process.env.OPENAI_API_KEY;
    const budget = Number(process.env.OPENAI_MONTHLY_BUDGET_USD ?? '200') || 200;
    const over = await step.run('check-budget', async () => {
      const db = getDb();
      return isOverMonthlyBudget(db, 'openai', budget);
    });
    if (over.over || !apiKey) {
      logger.error('reason.budget_exceeded_or_no_key', {
        sessionId,
        spent: over.spent,
        budget,
        hasKey: !!apiKey,
      });
      await step.run('mark-error', async () => {
        const db = getDb();
        await db
          .update(sessionsTable)
          .set({ state: 'error', updatedAt: sql`now()` })
          .where(eq(sessionsTable.id, sessionId));
      });
      return { status: 'budget-or-key' as const };
    }

    // ---- 3. Call OpenAI --------------------------------------------------
    const model = process.env.OPENAI_MODEL?.trim() || GPT_4O_MINI;
    // step.run return values round-trip through JSON — timestamp fields
    // arrive as ISO strings despite Drizzle's `Date` type. Coerce defensively.
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

    const result = await step.run('call-openai', async () => {
      return reasonOverSession({ apiKey, model, context: reasonInput, provider: 'openai' });
    });

    // ---- 4. Persist reasoning_run + proposed_tasks + cost ---------------
    const proposalIds = await step.run('persist', async () => {
      const db = getDb();
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

      // Update the session state + back-fill reasoning_run_id.
      const newState = tasks.length > 0 ? 'awaiting_approval' : 'closed';
      await db
        .update(sessionsTable)
        .set({
          state: newState,
          reasoningRunId: run.id,
          closedAt: newState === 'closed' ? new Date() : null,
          updatedAt: sql`now()`,
        })
        .where(eq(sessionsTable.id, sessionId));

      return { runId: run.id, proposalIds: tasks.map((t) => t.id), newState };
    });

    if (proposalIds.proposalIds.length === 0) {
      logger.info('reason.no_tasks', { sessionId });
      return {
        status: 'no-tasks' as const,
        runId: proposalIds.runId,
        costUsd: result.costUsd,
      };
    }

    // ---- 5. Emit proposal.created (Phase 5 UI + Phase 9 Telegram) -------
    await step.sendEvent('emit-proposal', {
      name: 'nexus/proposal.created',
      data: {
        sessionId,
        reasoningRunId: proposalIds.runId,
        proposedTaskIds: proposalIds.proposalIds,
      },
    });

    return {
      status: 'proposed' as const,
      runId: proposalIds.runId,
      proposedTaskIds: proposalIds.proposalIds,
      costUsd: result.costUsd,
    };
  },
);
