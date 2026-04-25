import { type NextRequest, NextResponse } from 'next/server';
import { serverEnv } from '@/lib/env';
import { getDb, costEvents as costEventsTable, sql, sessions as sessionsTable } from '@nexus/db';
import { checkRateLimit, apiRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for health endpoint to prevent abuse
    const rateLimit = checkRateLimit(req, apiRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('admin.health.rate_limited');
      return NextResponse.json(
        { error: 'Rate limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }

    // Check critical env vars without exposing values
    const checks = {
      resendApiKey: {
        set: !!serverEnv.RESEND_API_KEY,
        length: serverEnv.RESEND_API_KEY?.length || 0,
        startsWith: serverEnv.RESEND_API_KEY?.startsWith('re_') || false,
      },
      authSecret: {
        set: !!process.env.AUTH_SECRET,
        length: process.env.AUTH_SECRET?.length || 0,
      },
      adminAllowedEmails: {
        set: !!process.env.ADMIN_ALLOWED_EMAILS,
        parsed: serverEnv.ADMIN_ALLOWED_EMAILS,
        count: serverEnv.ADMIN_ALLOWED_EMAILS?.length || 0,
      },
      appUrl: {
        set: !!serverEnv.APP_URL,
        value: serverEnv.APP_URL,
      },
      resendFromEmail: {
        set: !!serverEnv.RESEND_FROM_EMAIL,
        value: serverEnv.RESEND_FROM_EMAIL,
      },
      databaseUrl: {
        set: !!process.env.DATABASE_URL,
        hasPassword: process.env.DATABASE_URL?.includes(':') || false,
      },
      inngest: {
        eventKey: !!process.env.INNGEST_EVENT_KEY,
        signingKey: !!process.env.INNGEST_SIGNING_KEY,
      },
      gmail: {
        clientId: !!process.env.GMAIL_OAUTH_CLIENT_ID,
        clientSecret: !!process.env.GMAIL_OAUTH_CLIENT_SECRET,
      },
      telegram: {
        botToken: !!process.env.TELEGRAM_BOT_TOKEN,
        adminIds: !!process.env.TELEGRAM_ADMIN_IDS,
        webhookSecret: !!process.env.TELEGRAM_WEBHOOK_SECRET,
      },
      anthropic: {
        apiKey: !!process.env.ANTHROPIC_API_KEY,
        budget: !!process.env.ANTHROPIC_MONTHLY_BUDGET_USD,
      },
      openai: {
        apiKey: !!process.env.OPENAI_API_KEY,
        budget: !!process.env.OPENAI_MONTHLY_BUDGET_USD,
      },
    };

    // Test database connection
    let dbStatus = 'unknown';
    try {
      const db = getDb();
      await db.execute('SELECT 1');
      dbStatus = 'connected';
    } catch (err) {
      dbStatus = `error: ${(err as Error).message}`;
      log.error('admin.health.db_error', { error: (err as Error).message });
    }

    // Get metrics
    let metrics = {};
    try {
      const db = getDb();
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Session metrics
      const [sessionMetrics] = await db
        .select({
          total: sql<number>`count(*)`,
          open: sql<number>`count(*) filter (where state = 'open')`,
          aggregating: sql<number>`count(*) filter (where state = 'aggregating')`,
          reasoning: sql<number>`count(*) filter (where state = 'reasoning')`,
          awaitingApproval: sql<number>`count(*) filter (where state = 'awaiting_approval')`,
          approved: sql<number>`count(*) filter (where state = 'approved')`,
          error: sql<number>`count(*) filter (where state = 'error')`,
        })
        .from(sessionsTable);

      // Cost metrics (this month). Service breakdown matches cost_service
      // enum (anthropic, openai, openai_whisper, assemblyai, r2, other) —
      // 'resend' is NOT a valid enum value, so filtering on it threw
      // `invalid input value for enum cost_service: "resend"` and aborted
      // the metrics block. Use 'other' if you need a catch-all bucket.
      // Pass timestamps as ISO strings — Drizzle's `${date}` interpolation
      // hands the Postgres driver a JS Date, which the node-postgres serializer
      // then rejects ("must be of type string or … Buffer / ArrayBuffer …").
      const monthStartIso = startOfMonth.toISOString();
      const dayStartIso = startOfDay.toISOString();
      const [costMetrics] = await db
        .select({
          total: sql<number>`coalesce(sum(cost_usd), 0)`,
          anthropic: sql<number>`coalesce(sum(cost_usd) filter (where service = 'anthropic'), 0)`,
          openai: sql<number>`coalesce(sum(cost_usd) filter (where service = 'openai'), 0)`,
          openai_whisper: sql<number>`coalesce(sum(cost_usd) filter (where service = 'openai_whisper'), 0)`,
          assemblyai: sql<number>`coalesce(sum(cost_usd) filter (where service = 'assemblyai'), 0)`,
          r2: sql<number>`coalesce(sum(cost_usd) filter (where service = 'r2'), 0)`,
        })
        .from(costEventsTable)
        .where(sql`${costEventsTable.occurredAt} >= ${monthStartIso}`);

      // Cost metrics (today)
      const [costToday] = await db
        .select({ total: sql<number>`coalesce(sum(cost_usd), 0)` })
        .from(costEventsTable)
        .where(sql`${costEventsTable.occurredAt} >= ${dayStartIso}`);

      metrics = {
        sessions: sessionMetrics,
        costs: {
          month: costMetrics,
          today: costToday,
        },
      };
    } catch (err) {
      metrics = { error: (err as Error).message };
      log.error('admin.health.metrics_error', { error: (err as Error).message });
    }

    return NextResponse.json(
      {
        ok: true,
        timestamp: new Date().toISOString(),
        nodeEnv: process.env.NODE_ENV,
        checks,
        dbStatus,
        metrics,
      },
      { status: 200 },
    );
  });
}
