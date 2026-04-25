import { type NextRequest, NextResponse } from 'next/server';
import { serverEnv } from '@/lib/env';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Vercel Cron: every 30 minutes, re-PUT `/api/inngest` so the function
 * registry on Inngest Cloud always points at the latest deployment URL
 * with the current set of registered handlers.
 *
 * Why: the Inngest SDK derives its callback URL on each PUT. If
 * INNGEST_SERVE_HOST drifts from the live alias (or a deploy lands
 * without an automatic sync), Inngest Cloud silently keeps invoking
 * the previous URL — which 404s on the next deploy. Periodically
 * re-PUTing forces the registration to re-converge.
 *
 * Auth: Vercel Cron Bearer token via CRON_SECRET.
 *
 * Configured in /vercel.json.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authz = req.headers.get('authorization') ?? '';
      if (authz !== `Bearer ${cronSecret}`) {
        log.warn('cron.sync-inngest.unauthorized');
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const host =
      process.env.INNGEST_SERVE_HOST?.trim() ||
      serverEnv.APP_URL.replace(/\/+$/, '');
    const url = `${host.replace(/\/+$/, '')}/api/inngest`;

    try {
      const res = await fetch(url, { method: 'PUT' });
      const body = await res.text();
      log.info('cron.sync-inngest.put_done', { url, status: res.status, body: body.slice(0, 200) });
      return NextResponse.json({ ok: true, url, status: res.status });
    } catch (err) {
      log.error('cron.sync-inngest.put_failed', {
        url,
        err: (err as Error).message,
      });
      return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  });
}
