import { type NextRequest, NextResponse } from 'next/server';
import {
  attachInteractionToSession,
  createContactWithIdentifier,
  findContactByIdentifier,
  getDb,
  interactions as interactionsTable,
  isNull,
  setInteractionContact,
} from '@nexus/db';
import { extractIdentifier } from '@nexus/inngest-fns/functions';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron: every 2 minutes, drain any interactions that landed in
 * the DB without a contactId. Mirrors the Inngest `resolveAndAttach`
 * function but runs inline — no Inngest involvement.
 *
 * Why: the Inngest delivery path has been intermittent on this
 * project. resolveAndAttach is the FIRST step in the pipeline; if it
 * doesn't fire, nothing else can. This cron is a belt-and-suspenders
 * loop that guarantees forward progress regardless of Inngest health.
 *
 * Steps per interaction:
 *   1. extractIdentifier(channel, rawPayload)
 *   2. findContactByIdentifier OR createContactWithIdentifier (auto)
 *   3. setInteractionContact + attachInteractionToSession
 *
 * After this runs, the auto-reason cron picks up the resulting open
 * sessions and promotes them to reasoning when they age past
 * SESSION_COOLDOWN_MIN.
 *
 * Configured in /vercel.json.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authz = req.headers.get('authorization') ?? '';
      if (authz !== `Bearer ${cronSecret}`) {
        log.warn('cron.process-pending.unauthorized');
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const cooldownMin = Number(process.env.SESSION_COOLDOWN_MIN ?? '120') || 120;
    const db = getDb();

    // Pull a batch of unprocessed interactions. 25 per tick keeps us
    // well under the 60s function timeout even with a few R2 / DB
    // round-trips per row.
    const pending = await db
      .select({
        id: interactionsTable.id,
        channel: interactionsTable.channel,
        rawPayload: interactionsTable.rawPayload,
        sourceMessageId: interactionsTable.sourceMessageId,
        occurredAt: interactionsTable.occurredAt,
      })
      .from(interactionsTable)
      .where(isNull(interactionsTable.contactId))
      .limit(25);

    if (pending.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 });
    }

    const results: Array<{
      interactionId: string;
      status: string;
      contactId?: string;
      sessionId?: string;
    }> = [];

    for (const row of pending) {
      const identified = extractIdentifier(
        row.channel,
        row.rawPayload,
        row.sourceMessageId,
      );
      if (!identified) {
        results.push({ interactionId: row.id, status: 'no_identifier' });
        continue;
      }

      let contactId: string | null = null;
      try {
        const matched = await findContactByIdentifier(db, {
          kind: identified.kind,
          value: identified.value,
        });
        if (matched) {
          contactId = matched.contact.id;
        } else {
          // WhatsApp opt-in gate (#4 stage 1). When
          // WHATSAPP_DEFAULT_ALLOW=false, every freshly auto-created
          // WhatsApp contact starts with allow_action=false (and
          // allow_transcription=false). The interaction lands in the
          // DB but the auto-reason and auto-transcribe crons skip it
          // — operator must flip the toggle in /contacts to start
          // processing. Other channels (email, phone) keep the
          // permissive default so we don't accidentally silence
          // legitimate work.
          const waDefaultAllow =
            (process.env.WHATSAPP_DEFAULT_ALLOW ?? 'true').toLowerCase() !== 'false';
          const isWhatsApp = row.channel === 'whatsapp';
          const overrideAllow = isWhatsApp && !waDefaultAllow ? false : undefined;
          const created = await createContactWithIdentifier(db, {
            displayName: identified.displayHint ?? identified.value,
            identifier: { kind: identified.kind, value: identified.value },
            source: `cron:${row.channel}`,
            ...(overrideAllow !== undefined
              ? { allowAction: overrideAllow, allowTranscription: overrideAllow }
              : {}),
          });
          if (overrideAllow === false) {
            log.info('cron.process-pending.contact_auto_blocked', {
              contactId: created.contact.id,
              channel: row.channel,
              identifier: identified.value,
              reason: 'WHATSAPP_DEFAULT_ALLOW=false',
            });
          }
          contactId = created.contact.id;
        }
      } catch (err) {
        log.error('cron.process-pending.contact_failed', {
          interactionId: row.id,
          err: (err as Error).message,
        });
        results.push({ interactionId: row.id, status: 'contact_failed' });
        continue;
      }

      try {
        await setInteractionContact(db, row.id, contactId);
        const attached = await attachInteractionToSession(db, {
          interactionId: row.id,
          contactId,
          occurredAt: new Date(row.occurredAt as unknown as string | number | Date),
          cooldownMinutes: cooldownMin,
        });
        results.push({
          interactionId: row.id,
          status: attached.newlyOpened ? 'session_opened' : 'session_extended',
          contactId,
          sessionId: attached.session.id,
        });
      } catch (err) {
        log.error('cron.process-pending.attach_failed', {
          interactionId: row.id,
          err: (err as Error).message,
        });
        results.push({ interactionId: row.id, status: 'attach_failed', contactId });
      }
    }

    log.info('cron.process-pending.done', {
      total: pending.length,
      session_opened: results.filter((r) => r.status === 'session_opened').length,
      session_extended: results.filter((r) => r.status === 'session_extended').length,
      no_identifier: results.filter((r) => r.status === 'no_identifier').length,
      failed: results.filter((r) => r.status.endsWith('_failed')).length,
    });

    return NextResponse.json({
      ok: true,
      processed: results.length,
      results: results.slice(0, 10),
    });
  });
}
