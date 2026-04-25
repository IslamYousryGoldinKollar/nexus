import { type NextRequest, NextResponse } from 'next/server';
import { getDb, interactions as interactionsTable, eq, and, isNull } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Process backlog endpoint - manually triggers the pipeline for unprocessed interactions.
 * This bypasses the Inngest webhook transform issue by directly emitting events.
 * 
 * GET /api/admin/process-backlog?limit=10&dryRun=true
 * 
 * Params:
 * - limit: max interactions to process (default 10)
 * - dryRun: if true, only shows what would be done (default true)
 * - key: admin API key (required)
 */
export async function GET(req: NextRequest) {
  // Rate limiting for admin endpoints
  const rateLimit = checkRateLimit(req, strictRateLimiter);
  if (!rateLimit.allowed) {
    log.warn('admin.process-backlog.rate_limited');
    return NextResponse.json(
      { error: 'Rate limited' },
      { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } }
    );
  }

  const adminKey = process.env.ADMIN_API_KEY;
  const providedKey = req.headers.get('x-admin-key') || req.nextUrl.searchParams.get('key');
  
  if (!adminKey || providedKey !== adminKey) {
    log.warn('admin.process-backlog.unauthorized');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '10', 10);
  const dryRun = req.nextUrl.searchParams.get('dryRun') !== 'false';

  if (limit > 100) {
    return NextResponse.json({ error: 'Limit cannot exceed 100' }, { status: 400 });
  }

  try {
    const db = getDb();
    
    // Find unprocessed WhatsApp interactions
    const unprocessed = await db
      .select({
        id: interactionsTable.id,
        sourceMessageId: interactionsTable.sourceMessageId,
        channel: interactionsTable.channel,
        contentType: interactionsTable.contentType,
        rawPayload: interactionsTable.rawPayload,
        occurredAt: interactionsTable.occurredAt,
      })
      .from(interactionsTable)
      .where(and(
        eq(interactionsTable.channel, 'whatsapp'),
        isNull(interactionsTable.contactId)
      ))
      .limit(limit);

    if (unprocessed.length === 0) {
      return NextResponse.json({ 
        message: 'No unprocessed WhatsApp interactions found',
        processed: 0,
        dryRun 
      }, { status: 200 });
    }

    const results = [];
    
    for (const interaction of unprocessed) {
      const result: Record<string, unknown> = {
        interactionId: interaction.id,
        sourceMessageId: interaction.sourceMessageId,
        channel: interaction.channel,
        contentType: interaction.contentType,
      };

      if (!dryRun) {
        // Emit the Inngest event directly
        try {
          const event = await inngest.send({
            name: 'nexus/interaction.ingested',
            data: {
              interactionId: interaction.id,
              channel: interaction.channel,
              sourceMessageId: interaction.sourceMessageId,
              occurredAt: interaction.occurredAt.toISOString(),
            },
          });
          result.eventEmitted = true;
          result.eventIds = event.ids;
          log.info('admin.process-backlog.interaction_processed', { interactionId: interaction.id });
        } catch (emitErr) {
          result.eventEmitted = false;
          result.error = (emitErr as Error).message;
          log.error('admin.process-backlog.emit_failed', {
            interactionId: interaction.id,
            error: (emitErr as Error).message,
          });
        }
      }

      results.push(result);
    }

    log.info('admin.process-backlog.completed', {
      processed: results.length,
      totalUnprocessed: unprocessed.length,
      dryRun,
    });

    return NextResponse.json({
      dryRun,
      processed: results.length,
      totalUnprocessed: unprocessed.length,
      results,
      note: dryRun 
        ? 'Set dryRun=false to actually emit events' 
        : 'Events emitted. Check Inngest dashboard for function runs.',
    }, { status: 200 });

  } catch (err) {
    log.error('admin.process-backlog.error', {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
