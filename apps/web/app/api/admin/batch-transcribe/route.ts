import { type NextRequest, NextResponse } from 'next/server';
import {
  getDb,
  attachments,
  transcripts,
  interactions as interactionsTable,
  eq,
  and,
  isNull,
  sql,
} from '@nexus/db';
import { supabaseStorageCredsFromEnv, signSupabaseGetUrl } from '@nexus/services';
import { transcribe } from '@nexus/services';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes for batch transcription

/**
 * @deprecated TEMPORARY workaround for the Inngest transcription pipeline
 * (suspected env-var newline corruption — fixed in commit `d420e9a`).
 * Slated for removal once `nexus/transcription.requested` events deliver
 * end-to-end in prod. See `docs/runbook.md` § "Debug endpoints (temporary)".
 *
 * Batch transcribe all untranscribed audio attachments.
 *
 * GET /api/admin/batch-transcribe?limit=5
 *
 * Auth: Requires ADMIN_API_KEY via x-admin-key header or key query param.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for admin endpoints
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('admin.batch-transcribe.rate_limited');
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

    // Debug auth
    if (req.nextUrl.searchParams.get('debug') === 'true') {
      return NextResponse.json(
        {
          hasAdminKey: !!adminKey,
          adminKeyLength: adminKey?.length,
          adminKeyPrefix: adminKey?.substring(0, 8),
          providedKeyLength: providedKey?.length,
          providedKeyPrefix: providedKey?.substring(0, 8),
          keysMatch: adminKey === providedKey,
        },
        { status: 200 },
      );
    }

    if (!adminKey || providedKey !== adminKey) {
      log.warn('admin.batch-transcribe.unauthorized');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = parseInt(req.nextUrl.searchParams.get('limit') || '3', 10);
    if (limit > 10) {
      return NextResponse.json({ error: 'Limit cannot exceed 10' }, { status: 400 });
    }

    try {
      const db = getDb();
      const storageCreds = supabaseStorageCredsFromEnv();

      if (!storageCreds) {
        log.error('admin.batch-transcribe.no_storage_creds');
        return NextResponse.json({ error: 'No Supabase Storage credentials' }, { status: 500 });
      }

      // Find audio/video attachments without transcripts
      const untranscribed = await db
        .select({
          attachmentId: attachments.id,
          r2Key: attachments.r2Key,
          mimeType: attachments.mimeType,
          interactionId: attachments.interactionId,
        })
        .from(attachments)
        .leftJoin(transcripts, eq(transcripts.attachmentId, attachments.id))
        .where(
          and(
            isNull(transcripts.id),
            sql`${attachments.mimeType} LIKE 'audio%' OR ${attachments.mimeType} LIKE 'video%'`,
          ),
        )
        .limit(limit);

      if (untranscribed.length === 0) {
        return NextResponse.json(
          {
            message: 'No untranscribed attachments',
            processed: 0,
          },
          { status: 200 },
        );
      }

      const results = [];

      for (const att of untranscribed) {
        const attResult: Record<string, unknown> = {
          attachmentId: att.attachmentId,
          r2Key: att.r2Key,
          mimeType: att.mimeType,
        };

        try {
          // Only process audio/video
          if (!att.mimeType.startsWith('audio') && !att.mimeType.startsWith('video')) {
            attResult['skipped'] = true;
            attResult['reason'] = 'Not audio/video';
            results.push(attResult);
            continue;
          }

          // Generate signed URL
          const audioUrl = await signSupabaseGetUrl(storageCreds, att.r2Key, 15 * 60);

          // Transcribe
          const transcriptResult = await transcribe({
            audioUrl,
            mimeType: att.mimeType,
          });

          // Save transcript
          const newTranscripts = await db
            .insert(transcripts)
            .values({
              attachmentId: att.attachmentId,
              text: transcriptResult.text,
              provider: transcriptResult.provider,
              language: transcriptResult.language,
              costUsd: transcriptResult.costUsdMillis
                ? Math.round(transcriptResult.costUsdMillis / 1000)
                : 0,
            })
            .returning({ id: transcripts.id });

          if (!newTranscripts[0]) {
            throw new Error('Failed to insert transcript');
          }

          // Update interaction.text with transcript
          await db
            .update(interactionsTable)
            .set({ text: transcriptResult.text })
            .where(
              and(eq(interactionsTable.id, att.interactionId), isNull(interactionsTable.text)),
            );

          attResult['success'] = true;
          attResult['transcriptId'] = newTranscripts[0].id;
          attResult['text'] = transcriptResult.text.substring(0, 100);
          attResult['language'] = transcriptResult.language;
          log.info('admin.batch-transcribe.attachment_processed', {
            attachmentId: att.attachmentId,
            language: transcriptResult.language,
          });
        } catch (err) {
          attResult['success'] = false;
          attResult['error'] = (err as Error).message;
          log.error('admin.batch-transcribe.attachment_failed', {
            attachmentId: att.attachmentId,
            error: (err as Error).message,
          });
        }

        results.push(attResult);
      }

      log.info('admin.batch-transcribe.completed', {
        processed: results.length,
        successful: results.filter((r) => r['success']).length,
      });

      return NextResponse.json(
        {
          processed: results.length,
          results,
        },
        { status: 200 },
      );
    } catch (err) {
      log.error('admin.batch-transcribe.error', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  });
}
