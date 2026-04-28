import { type NextRequest, NextResponse } from 'next/server';
import {
  transcripts as transcriptsTable,
  interactions as interactionsTable,
  eq,
  and,
  isNull,
  sql,
  getDb,
} from '@nexus/db';
import {
  supabaseStorageCredsFromEnv,
  signSupabaseGetUrl,
  transcribe,
} from '@nexus/services';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Whisper takes 5–15s per audio file; cap the batch and the timeout so
// one slow file can't take the whole tick down.
export const maxDuration = 120;

/**
 * Vercel Cron: every 2 minutes, transcribe up to 5 audio/video
 * attachments that don't yet have a `transcripts` row. Mirrors the
 * Inngest `transcribeAttachment` flow but runs inline because the
 * `nexus/transcription.requested` event delivery has been unreliable.
 *
 * The reasoning step needs `interactions.text` populated for audio
 * messages — without this, GPT sees `text: null` and can't extract
 * tasks. Running on a 2-minute cadence keeps WhatsApp voice notes
 * reaching reasoning within ~4 min of arrival.
 *
 * Configured in /apps/web/vercel.json.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authz = req.headers.get('authorization') ?? '';
      if (authz !== `Bearer ${cronSecret}`) {
        log.warn('cron.auto-transcribe.unauthorized');
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const storageCreds = supabaseStorageCredsFromEnv();
    if (!storageCreds) {
      log.error('cron.auto-transcribe.no_storage_creds');
      return NextResponse.json(
        { ok: false, error: 'no_storage_creds' },
        { status: 503 },
      );
    }

    const db = getDb();

    // Find audio/video attachments without transcripts. The previous
    // batch-transcribe admin endpoint produced duplicate transcripts
    // because the leftJoin returned the same attachment row multiple
    // times when callers retried — guard with a `DISTINCT ON` here so
    // the per-tick batch is unique.
    //
    // Privacy gate: skip attachments belonging to contacts whose
    // `allow_transcription` flag is false. Done at the SQL level so we
    // don't waste an OpenAI API call (and the resulting cost) on
    // recordings the user explicitly opted out of. Interactions with
    // no session, or sessions with no contact, fall through (treated
    // as allowed — we can't block what we can't attribute).
    const untranscribed = await db.execute(sql`
      SELECT DISTINCT ON (a.id)
        a.id          as "attachmentId",
        a.r2_key      as "r2Key",
        a.mime_type   as "mimeType",
        a.interaction_id as "interactionId"
      FROM attachments a
      LEFT JOIN transcripts t ON t.attachment_id = a.id
      LEFT JOIN interactions i ON i.id = a.interaction_id
      LEFT JOIN sessions s ON s.id = i.session_id
      LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE t.id IS NULL
        AND (a.mime_type LIKE 'audio%' OR a.mime_type LIKE 'video%')
        AND (c.id IS NULL OR c.allow_transcription = true)
      ORDER BY a.id
      LIMIT 5
    `);

    const rows = (untranscribed as unknown as Array<{
      attachmentId: string;
      r2Key: string;
      mimeType: string;
      interactionId: string;
    }>);

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 });
    }

    const results: Array<{
      attachmentId: string;
      status: 'transcribed' | 'failed';
      transcriptId?: string;
      language?: string;
      textPreview?: string;
      error?: string;
    }> = [];
    for (const att of rows) {
      try {
        const audioUrl = await signSupabaseGetUrl(storageCreds, att.r2Key, 15 * 60);
        const tr = await transcribe({ audioUrl, mimeType: att.mimeType });

        const inserted = await db
          .insert(transcriptsTable)
          .values({
            attachmentId: att.attachmentId,
            text: tr.text,
            provider: tr.provider,
            language: tr.language,
            costUsd: tr.costUsdMillis ? Math.round(tr.costUsdMillis / 1000) : 0,
          })
          .returning({ id: transcriptsTable.id });

        // Mirror transcript onto interactions.text so the reasoning
        // context bundle picks it up. Only update if the interaction
        // didn't already carry a caption (e.g. WhatsApp voice note with
        // a forwarded text caption).
        await db
          .update(interactionsTable)
          .set({ text: tr.text })
          .where(
            and(
              eq(interactionsTable.id, att.interactionId),
              isNull(interactionsTable.text),
            ),
          );

        results.push({
          attachmentId: att.attachmentId,
          status: 'transcribed',
          transcriptId: inserted[0]?.id,
          language: tr.language,
          textPreview: tr.text.slice(0, 80),
        });
        log.info('cron.auto-transcribe.success', {
          attachmentId: att.attachmentId,
          language: tr.language,
        });
      } catch (err) {
        results.push({
          attachmentId: att.attachmentId,
          status: 'failed',
          error: (err as Error).message,
        });
        log.error('cron.auto-transcribe.failed', {
          attachmentId: att.attachmentId,
          err: (err as Error).message,
        });
      }
    }

    // Touch the parent session so the reasoning cooldown clock sees
    // fresh activity — without this, a late-arriving transcript on an
    // already-cooled session would never trigger reasoning.
    const interactionIds = rows
      .filter((r, i) => results[i]?.status === 'transcribed')
      .map((r) => r.interactionId);
    if (interactionIds.length > 0) {
      await db.execute(sql`
        UPDATE sessions
        SET last_activity_at = now(), updated_at = now()
        WHERE id IN (
          SELECT session_id FROM interactions WHERE id = ANY(${interactionIds})
        )
      `);
    }

    return NextResponse.json({
      ok: true,
      processed: results.length,
      transcribed: results.filter((r) => r.status === 'transcribed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results,
    });
  });
}
