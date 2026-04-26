import { type NextRequest, NextResponse } from 'next/server';
import {
  and,
  eq,
  getDb,
  or,
  isNull,
  sql,
  proposedTasks as proposedTasksTable,
  approvedTasks as approvedTasksTable,
  attachments as attachmentsTable,
  interactions as interactionsTable,
  setProposedTaskSynced,
  upsertApprovedTask,
} from '@nexus/db';
import {
  createInjazTask,
  injazClientFromEnv,
  type InjazError,
  supabaseStorageCredsFromEnv,
  signSupabaseGetUrl,
} from '@nexus/services';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron: every 2 minutes, push any newly-approved proposed_task
 * to Injaz. Mirrors the Inngest `syncToInjaz` function but runs inline
 * because Inngest delivery has been unreliable on this project.
 *
 * Find work via a LEFT JOIN: proposed_tasks WHERE state = 'approved'
 * AND no row in approved_tasks (= never synced or sync failed).
 *
 * For each, POST to Injaz, then upsert approved_tasks + flip
 * proposed_task.state = 'synced'.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authz = req.headers.get('authorization') ?? '';
      if (authz !== `Bearer ${cronSecret}`) {
        log.warn('cron.sync-approved-injaz.unauthorized');
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const client = injazClientFromEnv();
    if (!client) {
      log.error('cron.sync-approved-injaz.no_creds');
      return NextResponse.json({ ok: false, error: 'no_creds' }, { status: 503 });
    }

    const db = getDb();

    // Tasks that are state=approved AND haven't been successfully synced
    // yet. Two cases:
    //   (a) no approved_tasks row at all (never tried)
    //   (b) approved_tasks row exists but syncState != 'synced' (last
    //       attempt failed or is mid-flight).
    const pending = await db
      .select({
        id: proposedTasksTable.id,
        sessionId: proposedTasksTable.sessionId,
        title: proposedTasksTable.title,
        description: proposedTasksTable.description,
        priorityGuess: proposedTasksTable.priorityGuess,
        dueDateGuess: proposedTasksTable.dueDateGuess,
        assigneeGuess: proposedTasksTable.assigneeGuess,
      })
      .from(proposedTasksTable)
      .leftJoin(approvedTasksTable, eq(approvedTasksTable.proposedTaskId, proposedTasksTable.id))
      .where(
        and(
          eq(proposedTasksTable.state, 'approved'),
          or(
            isNull(approvedTasksTable.id),
            sql`${approvedTasksTable.syncState} != 'synced'`,
          ),
        ),
      )
      .limit(20);

    if (pending.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 });
    }

    // Pre-fetch storage creds once; reused for every signed URL we mint
    // below. Missing creds means no audio/video links — text body still
    // syncs.
    const storageCreds = supabaseStorageCredsFromEnv();

    const results: Array<{
      proposedTaskId: string;
      status: string;
      injazTaskId?: string;
      error?: string;
    }> = [];

    for (const task of pending) {
      try {
        const description = await buildEnrichedDescription(
          db,
          task.sessionId,
          task.description,
          storageCreds,
        );

        const injazTask = await createInjazTask(client, {
          title: task.title,
          description,
          priority: task.priorityGuess,
          dueDate: task.dueDateGuess ? (task.dueDateGuess as unknown as string) : null,
          assignee: task.assigneeGuess,
          externalRefId: task.id,
        });

        await upsertApprovedTask(db, {
          proposedTaskId: task.id,
          injazTaskId: injazTask.id,
          syncState: 'synced',
          lastSyncedAt: new Date(),
          syncError: null,
        });
        await setProposedTaskSynced(db, task.id);

        results.push({
          proposedTaskId: task.id,
          status: 'synced',
          injazTaskId: injazTask.id,
        });
        log.info('cron.sync-approved-injaz.synced', {
          proposedTaskId: task.id,
          injazTaskId: injazTask.id,
        });
      } catch (err) {
        const ie = err as InjazError;
        await upsertApprovedTask(db, {
          proposedTaskId: task.id,
          syncState: 'pending',
          syncError: `${ie.status ?? 0}: ${(err as Error).message}`.slice(0, 1000),
        });
        results.push({
          proposedTaskId: task.id,
          status: 'failed',
          error: (err as Error).message,
        });
        log.error('cron.sync-approved-injaz.failed', {
          proposedTaskId: task.id,
          status: ie.status,
          err: (err as Error).message,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      processed: pending.length,
      synced: results.filter((r) => r.status === 'synced').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results,
    });
  });
}

/**
 * Append a "Source attachments" block with 24-hour signed URLs for any
 * audio/video/image/document attached to interactions in the originating
 * session. The URLs are short-lived but easy for Islam to refresh by
 * clicking the Injaz task back into Nexus.
 *
 * Failures inside the helper return the original description — sync
 * should never fail because we couldn't sign a URL.
 */
async function buildEnrichedDescription(
  db: ReturnType<typeof getDb>,
  sessionId: string | null,
  baseDescription: string,
  storageCreds: ReturnType<typeof supabaseStorageCredsFromEnv>,
): Promise<string> {
  if (!sessionId || !storageCreds) return baseDescription;

  try {
    const atts = await db
      .select({
        id: attachmentsTable.id,
        r2Key: attachmentsTable.r2Key,
        mimeType: attachmentsTable.mimeType,
        sizeBytes: attachmentsTable.sizeBytes,
        interactionId: attachmentsTable.interactionId,
      })
      .from(attachmentsTable)
      .innerJoin(interactionsTable, eq(interactionsTable.id, attachmentsTable.interactionId))
      .where(eq(interactionsTable.sessionId, sessionId))
      .limit(20);

    if (atts.length === 0) return baseDescription;

    const lines = ['', '---', 'Source attachments (links valid 24h):'];
    for (const a of atts) {
      try {
        const url = await signSupabaseGetUrl(storageCreds, a.r2Key, 24 * 60 * 60);
        const kind = a.mimeType.startsWith('audio')
          ? '🎤 Voice'
          : a.mimeType.startsWith('video')
            ? '🎥 Video'
            : a.mimeType.startsWith('image')
              ? '🖼️ Image'
              : '📎 File';
        const sizeKb = a.sizeBytes ? ` (${Math.round(a.sizeBytes / 1024)} KB)` : '';
        lines.push(`- ${kind}${sizeKb}: ${url}`);
      } catch (err) {
        log.warn('cron.sync-approved-injaz.sign_url_failed', {
          attachmentId: a.id,
          err: (err as Error).message,
        });
      }
    }
    return baseDescription + '\n' + lines.join('\n');
  } catch (err) {
    log.warn('cron.sync-approved-injaz.attach_lookup_failed', {
      sessionId,
      err: (err as Error).message,
    });
    return baseDescription;
  }
}
