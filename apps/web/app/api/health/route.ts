import { NextResponse } from 'next/server';
import { getDb, sql } from '@nexus/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness + readiness probe.
 *
 * Reports both `status` (overall) and `checks` (per-dependency). Status
 * is `degraded` if any non-critical check fails, `down` if DB ping
 * fails, `ok` otherwise. The body always returns 200 so generic
 * Vercel/Uptime probes don't flap on degradation; clients should look
 * at `status` for nuance.
 *
 * The DB check is a `select 1` with a 1.5 s timeout — we deliberately
 * avoid hammering the pool.
 */

interface HealthChecks {
  db: 'ok' | 'down' | 'skipped';
  inngest: 'configured' | 'missing';
  anthropic: 'configured' | 'missing';
  whisper: 'configured' | 'missing';
  resend: 'configured' | 'missing';
  storage: 'configured' | 'missing';
}

async function checkDb(): Promise<'ok' | 'down'> {
  try {
    const db = getDb();
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('db ping timeout')), 1500),
      ),
    ]);
    return 'ok';
  } catch {
    return 'down';
  }
}

export async function GET() {
  const env = (k: string) => Boolean(process.env[k]);
  // Storage: accept either Cloudflare R2 credentials OR Supabase Storage
  //   (bucket + service-role key on the same Supabase project). We don't
  //   require R2 — many deployments use Supabase Storage exclusively.
  const storageOk =
    env('R2_ACCESS_KEY_ID') ||
    (env('SUPABASE_STORAGE_BUCKET') && env('SUPABASE_SERVICE_ROLE_KEY'));
  // Inngest: the serve endpoint needs SIGNING key; outbound sends need
  //   EVENT key. Report configured if at least one is set, so a fresh
  //   deploy doesn't look broken while the event key is being provisioned.
  const inngestOk = env('INNGEST_SIGNING_KEY') || env('INNGEST_EVENT_KEY');
  const checks: HealthChecks = {
    db: env('DATABASE_URL') ? await checkDb() : 'skipped',
    inngest: inngestOk ? 'configured' : 'missing',
    anthropic: env('ANTHROPIC_API_KEY') ? 'configured' : 'missing',
    whisper: env('OPENAI_API_KEY') ? 'configured' : 'missing',
    resend: env('RESEND_API_KEY') ? 'configured' : 'missing',
    storage: storageOk ? 'configured' : 'missing',
  };

  const status: 'ok' | 'degraded' | 'down' =
    checks.db === 'down' ? 'down' :
    Object.values(checks).some((v) => v === 'missing') ? 'degraded' :
    'ok';

  return NextResponse.json(
    {
      status,
      service: 'nexus-web',
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev',
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: status === 'down' ? 503 : 200 },
  );
}
