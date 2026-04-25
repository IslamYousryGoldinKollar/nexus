import { type NextRequest, NextResponse } from 'next/server';
import { getDb, sessions, interactions as interactionsTable, eq, sql } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manually trigger the reasoning phase for a session.
 * This bypasses the Inngest webhook transform issue.
 *
 * GET /api/admin/trigger-reasoning?sessionId=<uuid>
 * GET /api/admin/trigger-reasoning?all=true (triggers all open sessions)
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for admin endpoints
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('admin.trigger-reasoning.rate_limited');
      return NextResponse.json(
        { error: 'Rate limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }

    const adminKey = process.env.ADMIN_API_KEY?.trim();
    const providedKey = (
      req.headers.get('x-admin-key') ||
      req.nextUrl.searchParams.get('key') ||
      ''
    ).trim();

    if (!adminKey || providedKey !== adminKey) {
      log.warn('admin.trigger-reasoning.unauthorized');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const sessionId = req.nextUrl.searchParams.get('sessionId');
    const all = req.nextUrl.searchParams.get('all') === 'true';

    try {
      const db = getDb();

      let targetSessions: Array<{ id: string; contactId: string | null }> = [];

      if (sessionId) {
        const result = await db
          .select({ id: sessions.id, contactId: sessions.contactId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        targetSessions = result;
      } else if (all) {
        // Get all open sessions with at least one interaction
        const result = await db
          .selectDistinct({
            id: sessions.id,
            contactId: sessions.contactId,
          })
          .from(sessions)
          .innerJoin(interactionsTable, eq(interactionsTable.sessionId, sessions.id))
          .where(eq(sessions.state, 'open'));
        targetSessions = result;
      } else {
        return NextResponse.json(
          {
            error: 'Must provide sessionId or all=true',
          },
          { status: 400 },
        );
      }

      if (targetSessions.length === 0) {
        return NextResponse.json(
          {
            message: 'No sessions to process',
            triggered: 0,
          },
          { status: 200 },
        );
      }

      const results = [];

      for (const session of targetSessions) {
        try {
          // Update session state to reasoning
          await db
            .update(sessions)
            .set({ state: 'reasoning', updatedAt: sql`now()` })
            .where(eq(sessions.id, session.id));

          // Fire reasoning event
          const event = await inngest.send({
            name: 'nexus/session.reasoning.requested',
            data: {
              sessionId: session.id,
              trigger: 'manual',
            },
          });

          results.push({
            sessionId: session.id,
            contactId: session.contactId,
            triggered: true,
            eventIds: event.ids,
          });
          log.info('admin.trigger-reasoning.session_triggered', { sessionId: session.id });
        } catch (err) {
          log.error('admin.trigger-reasoning.session_failed', {
            sessionId: session.id,
            error: (err as Error).message,
          });
          results.push({
            sessionId: session.id,
            triggered: false,
            error: (err as Error).message,
          });
        }
      }

      log.info('admin.trigger-reasoning.completed', {
        triggered: results.filter((r) => r.triggered).length,
        total: results.length,
      });

      return NextResponse.json(
        {
          triggered: results.filter((r) => r.triggered).length,
          total: results.length,
          results,
        },
        { status: 200 },
      );
    } catch (err) {
      log.error('admin.trigger-reasoning.error', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  });
}
