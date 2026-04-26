import { type NextRequest, NextResponse } from 'next/server';
import { getDb, sql } from '@nexus/db';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * WhatsApp bridge watchdog.
 *
 * Baileys (the WhatsApp lib wa-bridge runs on) has a long-known
 * silent-disconnect failure: the WebSocket gets closed by the remote,
 * the keepalive doesn't notice for hours, the bridge thinks it's still
 * connected (`/health` returns ok=true, hasQr=false), but no inbound
 * messages flow. We hit this on Apr 25 — bridge ran fine for 5 days
 * then stopped delivering messages without ever firing
 * `connection.close`.
 *
 * Detection: query the DB for the latest `whatsapp` interaction. If it's
 * older than `?stalenessMin` (default 30) and there's anything older
 * than 24h to compare against (= the bridge has worked at least once),
 * trigger a restart.
 *
 * Restart: POST to wa-bridge `/restart?t=<token>`. The endpoint calls
 * `process.exit(0)`; Fly's restart policy spins a fresh container with
 * a fresh Baileys WebSocket. Existing pair stays valid (auth state is
 * persisted on a Fly volume).
 *
 * Configured to be called every 5 min by .github/workflows/cron-pings.yml.
 *
 * Auth: ADMIN_API_KEY via `?key=` or `x-admin-key` header.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const adminKey = process.env.ADMIN_API_KEY?.trim();
    const provided = (
      req.headers.get('x-admin-key') ||
      req.nextUrl.searchParams.get('key') ||
      ''
    ).trim();
    if (!adminKey || provided !== adminKey) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    const stalenessMin = Number(req.nextUrl.searchParams.get('stalenessMin') ?? '30');
    const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';

    const db = getDb();
    const rows = (await db.execute(sql`
      SELECT
        max(occurred_at) as last_at,
        count(*) FILTER (WHERE occurred_at > now() - interval '24 hours')::int as last_24h
      FROM interactions
      WHERE channel = 'whatsapp'
    `)) as unknown as Array<{ last_at: string | null; last_24h: number }>;
    const stats = rows[0] ?? { last_at: null, last_24h: 0 };

    const now = Date.now();
    const lastAtMs = stats.last_at ? new Date(stats.last_at).getTime() : 0;
    const ageMin = lastAtMs ? Math.round((now - lastAtMs) / 60000) : null;
    const stale = ageMin !== null && ageMin > stalenessMin;

    // Don't restart if we've never received a message — that means the
    // bridge isn't paired yet, restart won't help, and the QR cycle
    // would get interrupted.
    const everReceived = stats.last_24h > 0 || lastAtMs > 0;

    const baseInfo = {
      lastWhatsAppAt: stats.last_at,
      ageMinutes: ageMin,
      stalenessThresholdMin: stalenessMin,
      last24h: stats.last_24h,
      everReceived,
      stale,
    };

    if (!stale || !everReceived) {
      log.info('wa-watchdog.healthy', baseInfo);
      return NextResponse.json({ ...baseInfo, action: 'none' });
    }

    if (dryRun) {
      return NextResponse.json({ ...baseInfo, action: 'would-restart' });
    }

    const bridgeUrl = process.env.WA_BRIDGE_URL?.trim() || 'https://nexus-wa-bridge.fly.dev';
    const token = (process.env.WA_BRIDGE_QR_TOKEN || process.env.WA_BRIDGE_HMAC_SECRET)?.trim();
    if (!token) {
      log.error('wa-watchdog.no_token');
      return NextResponse.json(
        { ...baseInfo, action: 'error', error: 'no WA_BRIDGE_QR_TOKEN/HMAC_SECRET' },
        { status: 503 },
      );
    }

    try {
      const res = await fetch(`${bridgeUrl.replace(/\/$/, '')}/restart?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.text().catch(() => '');
      log.warn('wa-watchdog.restart_triggered', {
        ...baseInfo,
        status: res.status,
        body: body.slice(0, 200),
      });
      return NextResponse.json({
        ...baseInfo,
        action: 'restart',
        bridgeStatus: res.status,
        bridgeResponse: body.slice(0, 200),
      });
    } catch (err) {
      log.error('wa-watchdog.restart_failed', {
        ...baseInfo,
        err: (err as Error).message,
      });
      return NextResponse.json(
        { ...baseInfo, action: 'error', error: (err as Error).message },
        { status: 502 },
      );
    }
  });
}
