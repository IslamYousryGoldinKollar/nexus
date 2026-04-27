import { type NextRequest, NextResponse } from 'next/server';
import { getDb, sql } from '@nexus/db';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Vercel Cron version of the WhatsApp bridge watchdog. Identical
 * detection + restart logic as /api/admin/wa-watchdog, but uses the
 * Vercel-injected `Authorization: Bearer <CRON_SECRET>` rather than
 * an admin-key query param.
 *
 * Why two endpoints exist:
 *   - /api/admin/wa-watchdog stays for manual debugging via curl
 *     (admin key in URL, easier to invoke from a terminal).
 *   - /api/cron/wa-watchdog is what vercel.json schedules every 2 min.
 *
 * Detection: query the DB for the latest `whatsapp` interaction. If
 * older than `?stalenessMin` (default 30) AND we have ever received
 * any WhatsApp message (so we never restart-storm an unpaired bridge),
 * POST to wa-bridge `/restart?t=<token>`. Fly's restart policy then
 * spins a fresh container with a fresh Baileys WebSocket.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authz = req.headers.get('authorization') ?? '';
      if (authz !== `Bearer ${cronSecret}`) {
        log.warn('cron.wa-watchdog.unauthorized');
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const stalenessMin = Number(
      req.nextUrl.searchParams.get('stalenessMin') ??
        process.env.WATCHDOG_STALENESS_MIN ??
        '30',
    );

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
      return NextResponse.json({ ok: true, ...baseInfo, action: 'none' });
    }

    const bridgeUrl = process.env.WA_BRIDGE_URL?.trim() || 'https://nexus-wa-bridge.fly.dev';

    // Don't restart-loop. If the bridge has been up < 6 min, give it
    // time to handshake + drain offline messages before another
    // restart. Without this every 2-min cron tick kicks the bridge
    // again before its previous restart finished settling — which on
    // a corrupted Signal session just compounds the corruption.
    try {
      const h = await fetch(`${bridgeUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const hb = (await h.json().catch(() => ({}))) as { uptimeSec?: number };
      if (typeof hb.uptimeSec === 'number' && hb.uptimeSec < 360) {
        return NextResponse.json({
          ok: true,
          ...baseInfo,
          action: 'skipped-too-young',
          bridgeUptimeSec: hb.uptimeSec,
        });
      }
    } catch {
      /* health check failed — proceed with restart anyway */
    }

    const token = (process.env.WA_BRIDGE_QR_TOKEN || process.env.WA_BRIDGE_HMAC_SECRET)?.trim();
    if (!token) {
      log.error('cron.wa-watchdog.no_token');
      return NextResponse.json(
        { ok: false, ...baseInfo, action: 'error', error: 'no WA_BRIDGE_QR_TOKEN/HMAC_SECRET' },
        { status: 503 },
      );
    }

    try {
      const res = await fetch(
        `${bridgeUrl.replace(/\/$/, '')}/restart?t=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        },
      );
      const body = await res.text().catch(() => '');
      log.warn('cron.wa-watchdog.restart_triggered', {
        ...baseInfo,
        status: res.status,
        body: body.slice(0, 200),
      });
      return NextResponse.json({
        ok: true,
        ...baseInfo,
        action: 'restart',
        bridgeStatus: res.status,
        bridgeResponse: body.slice(0, 200),
      });
    } catch (err) {
      log.error('cron.wa-watchdog.restart_failed', {
        ...baseInfo,
        err: (err as Error).message,
      });
      return NextResponse.json(
        { ok: false, ...baseInfo, action: 'error', error: (err as Error).message },
        { status: 502 },
      );
    }
  });
}
