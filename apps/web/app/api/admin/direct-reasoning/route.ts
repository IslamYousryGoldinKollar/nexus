import { type NextRequest, NextResponse } from 'next/server';
import {
  eq,
  getDb,
  insertProposedTasks,
  insertReasoningRun,
  loadSessionContext,
  recordCostEvent,
  sessions as sessionsTable,
  sql,
} from '@nexus/db';
import { reasonOverSession, SONNET_4_5 } from '@nexus/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Direct reasoning endpoint — bypasses Inngest, runs Claude Sonnet 4.5 
 * over a session immediately.
 * 
 * GET /api/admin/direct-reasoning?sessionId=<uuid>
 * GET /api/admin/direct-reasoning?all=true
 */
export async function GET(req: NextRequest) {
  const adminKey = process.env.ADMIN_API_KEY?.trim();
  const providedKey = (req.headers.get('x-admin-key') || req.nextUrl.searchParams.get('key') || '').trim();
  
  if (!adminKey || providedKey !== adminKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = req.nextUrl.searchParams.get('sessionId');
  const all = req.nextUrl.searchParams.get('all') === 'true';

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  const db = getDb();
  const model = process.env.ANTHROPIC_MODEL?.trim() || SONNET_4_5;

  try {
    let targetSessionIds: string[] = [];
    
    if (sessionId) {
      targetSessionIds = [sessionId];
    } else if (all) {
      const openOrReasoning = await db
        .select({ id: sessionsTable.id })
        .from(sessionsTable)
        .where(sql`state IN ('open', 'reasoning')`);
      targetSessionIds = openOrReasoning.map(s => s.id);
    } else {
      return NextResponse.json({ 
        error: 'Must provide sessionId or all=true' 
      }, { status: 400 });
    }

    const results = [];

    for (const sid of targetSessionIds) {
      const sessionResult: Record<string, unknown> = { sessionId: sid };

      try {
        // Load context
        const ctx = await loadSessionContext(db, sid);
        if (!ctx) {
          sessionResult['status'] = 'not_found';
          results.push(sessionResult);
          continue;
        }
        
        if (ctx.interactions.length === 0) {
          sessionResult['status'] = 'empty';
          await db
            .update(sessionsTable)
            .set({ state: 'closed', closedAt: new Date(), updatedAt: sql`now()` })
            .where(eq(sessionsTable.id, sid));
          results.push(sessionResult);
          continue;
        }

        const toIso = (v: Date | string): string =>
          typeof v === 'string' ? v : v.toISOString();

        const reasonInput = {
          sessionId: sid,
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

        // Run Claude reasoning
        const result = await reasonOverSession({ 
          apiKey, 
          model, 
          context: reasonInput 
        });

        // Persist reasoning run
        const run = await insertReasoningRun(db, {
          sessionId: sid,
          model,
          systemPrompt: 'NEXUS_PERSONA + OUTPUT_CONTRACT (v1)',
          contextBundle: reasonInput as unknown as Record<string, unknown>,
          rawResponse: result.rawResponse as unknown as Record<string, unknown>,
          costUsd: result.costUsd.toFixed(6),
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
        });

        // Persist proposed tasks
        const tasks = await insertProposedTasks(
          db,
          result.output.proposedTasks.map((t) => ({
            sessionId: sid,
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
          }))
        );

        // Record cost event
        await recordCostEvent(db, {
          service: 'anthropic',
          operation: 'reason.session',
          costUsd: result.costUsd.toFixed(6),
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          sessionId: sid,
          metadata: {
            reasoningRunId: run.id,
            model,
            latencyMs: result.latencyMs,
            tasksProduced: tasks.length,
          },
        });

        // Transition session state
        const nextState = tasks.length > 0 ? 'awaiting_approval' : 'closed';
        await db
          .update(sessionsTable)
          .set({ 
            state: nextState, 
            reasoningRunId: run.id,
            closedAt: nextState === 'closed' ? new Date() : null,
            updatedAt: sql`now()`,
          })
          .where(eq(sessionsTable.id, sid));

        sessionResult['status'] = 'completed';
        sessionResult['reasoningRunId'] = run.id;
        sessionResult['taskCount'] = tasks.length;
        sessionResult['nextState'] = nextState;
        sessionResult['costUsd'] = result.costUsd;
        sessionResult['latencyMs'] = result.latencyMs;
        sessionResult['tasks'] = tasks.map(t => ({ id: t.id, title: result.output.proposedTasks.find(pt => pt.title)?.title }));
      } catch (err) {
        sessionResult['status'] = 'error';
        sessionResult['error'] = (err as Error).message;
      }

      results.push(sessionResult);
    }

    return NextResponse.json({
      processed: results.length,
      successful: results.filter(r => r['status'] === 'completed').length,
      results,
    }, { status: 200 });

  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, stack: (err as Error).stack },
      { status: 500 }
    );
  }
}
