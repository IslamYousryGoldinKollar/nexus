import { type NextRequest, NextResponse } from 'next/server';
import { getDb, interactions as interactionsTable, eq } from '@nexus/db';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manual resolve endpoint - bypasses Inngest and directly runs the
 * identity resolution logic for debugging.
 *
 * GET /api/admin/manual-resolve?interactionId=<uuid>
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for admin endpoints
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('admin.manual-resolve.rate_limited');
      return NextResponse.json(
        { error: 'Rate limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }

    const adminKey = process.env.ADMIN_API_KEY;
    const providedKey = req.headers.get('x-admin-key') || req.nextUrl.searchParams.get('key');

    if (!adminKey || providedKey !== adminKey) {
      log.warn('admin.manual-resolve.unauthorized');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const interactionId = req.nextUrl.searchParams.get('interactionId');
    if (!interactionId) {
      return NextResponse.json({ error: 'Missing interactionId' }, { status: 400 });
    }

    try {
      const db = getDb();

      // Load interaction
      const [interaction] = await db
        .select()
        .from(interactionsTable)
        .where(eq(interactionsTable.id, interactionId))
        .limit(1);

      if (!interaction) {
        log.warn('admin.manual-resolve.not_found', { interactionId });
        return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
      }

      // Manual extract identifier logic (inline to avoid import issues)
      const raw = interaction.rawPayload as Record<string, unknown>;
      const rawInner = raw?.raw as Record<string, unknown> | undefined;
      const key = rawInner?.key as Record<string, unknown> | undefined;

      const senderPn = typeof key?.senderPn === 'string' ? key.senderPn : null;
      const remoteJid = typeof key?.remoteJid === 'string' ? key.remoteJid : null;
      const pushName = typeof rawInner?.pushName === 'string' ? rawInner.pushName : null;
      const fromField = typeof raw.from === 'string' ? raw.from : null;

      const stripJid = (s: string | null): string | null => {
        if (!s) return null;
        const at = s.split('@')[0] ?? '';
        return (at.split(':')[0] ?? '') || null;
      };

      const isPhoneAddr = (s: string | null): s is string =>
        !!s && !s.includes('@lid') && !s.includes('@g.us') && !s.includes('@broadcast');

      const candidates = [senderPn, remoteJid, fromField].filter(isPhoneAddr);

      let identified = null;
      for (const cand of candidates) {
        const digits = stripJid(cand);
        if (digits && digits.length >= 7 && digits.length <= 15) {
          identified = {
            kind: 'whatsapp_wa_id',
            value: digits.startsWith('+') ? digits : '+' + digits,
            displayHint: pushName ?? cand,
          };
          break;
        }
      }

      // Simple result
      const result: Record<string, unknown> = {
        interactionId,
        channel: interaction.channel,
        contentType: interaction.contentType,
        sourceMessageId: interaction.sourceMessageId,
        rawPayload: {
          from: fromField,
          senderPn,
          remoteJid,
          pushName,
        },
        extractedIdentifier: identified,
        currentContactId: interaction.contactId,
        currentSessionId: interaction.sessionId,
      };

      log.info('admin.manual-resolve.completed', { interactionId, identified: !!identified });
      return NextResponse.json(result, { status: 200 });
    } catch (err) {
      log.error('admin.manual-resolve.error', {
        error: (err as Error).message,
        stack: (err as Error).stack,
        interactionId,
      });
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  });
}
