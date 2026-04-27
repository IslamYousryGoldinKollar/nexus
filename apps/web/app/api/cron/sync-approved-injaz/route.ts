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
  sessions as sessionsTable,
  contacts as contactsTable,
  setProposedTaskSynced,
  upsertApprovedTask,
} from '@nexus/db';
import {
  createInjazTask,
  createInjazParty,
  createInjazProject,
  injazClientFromEnv,
  type InjazError,
  supabaseStorageCredsFromEnv,
  signSupabaseGetUrl,
  updateInjazTaskViaMcp,
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
    // Pull the proposed task plus the contact's Injaz mapping in one
    // shot. Falls back gracefully when session.contactId or
    // contacts.injaz_project_name is null (those tasks just sync
    // without a project link, exactly like before this commit).
    const pending = await db
      .select({
        id: proposedTasksTable.id,
        sessionId: proposedTasksTable.sessionId,
        title: proposedTasksTable.title,
        description: proposedTasksTable.description,
        priorityGuess: proposedTasksTable.priorityGuess,
        startDateGuess: proposedTasksTable.startDateGuess,
        dueDateGuess: proposedTasksTable.dueDateGuess,
        assigneeGuess: proposedTasksTable.assigneeGuess,
        assigneeInjazUserName: proposedTasksTable.assigneeInjazUserName,
        injazExistingTaskId: proposedTasksTable.injazExistingTaskId,
        createClientName: proposedTasksTable.createClientName,
        createProjectName: proposedTasksTable.createProjectName,
        injazPartyName: contactsTable.injazPartyName,
        injazProjectName: contactsTable.injazProjectName,
      })
      .from(proposedTasksTable)
      .leftJoin(approvedTasksTable, eq(approvedTasksTable.proposedTaskId, proposedTasksTable.id))
      .leftJoin(sessionsTable, eq(sessionsTable.id, proposedTasksTable.sessionId))
      .leftJoin(contactsTable, eq(contactsTable.id, sessionsTable.contactId))
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

        // Operator-confirmed assignee wins over the AI's guess. The
        // contact's injaz_project_name (set via the contact-mapping UI)
        // routes the task into the right Injaz project.
        const assignee = task.assigneeInjazUserName ?? task.assigneeGuess ?? null;

        // Auto-provision client/project if the AI flagged them as new.
        // Both helpers treat "already exists" as a no-op success, so
        // it's safe to call them every time the field is set — even
        // if the AI got confused about whether it was new.
        let resolvedClientName = task.injazPartyName ?? null;
        if (task.createClientName) {
          await createInjazParty(client, { name: task.createClientName, type: 'CLIENT' });
          resolvedClientName = task.createClientName;
        }
        let resolvedProjectName = task.injazProjectName ?? null;
        if (task.createProjectName) {
          await createInjazProject(client, {
            name: task.createProjectName,
            clientName: resolvedClientName ?? undefined,
            description: `Auto-created from Nexus session ${task.sessionId.slice(0, 8)}`,
            status: 'ACTIVE',
          });
          resolvedProjectName = task.createProjectName;
        }

        // Convert Date columns to ISO strings for the MCP wrapper.
        const startDateIso = task.startDateGuess
          ? (task.startDateGuess as unknown as Date).toISOString()
          : null;
        const dueDateIso = task.dueDateGuess
          ? (task.dueDateGuess as unknown as Date).toISOString()
          : null;

        // Branch on whether the AI flagged this as updating an existing
        // Injaz task or creating a fresh one. The flag was already
        // validated against the snapshot of open tasks shown to the
        // model (see runReasoningForSession), so we trust it here.
        let syncMode: 'created' | 'updated';
        let injazId: string;
        if (task.injazExistingTaskId) {
          await updateInjazTaskViaMcp(client, task.injazExistingTaskId, {
            title: task.title,
            description,
            priority: task.priorityGuess,
            startDate: startDateIso,
            dueDate: dueDateIso,
            assignee,
            projectName: resolvedProjectName ?? undefined,
          });
          injazId = task.injazExistingTaskId;
          syncMode = 'updated';
        } else {
          const injazTask = await createInjazTask(client, {
            title: task.title,
            description,
            priority: task.priorityGuess,
            startDate: startDateIso,
            dueDate: dueDateIso,
            assignee,
            projectName: resolvedProjectName ?? undefined,
            externalRefId: task.id,
          });
          injazId = injazTask.id;
          syncMode = 'created';
        }

        await upsertApprovedTask(db, {
          proposedTaskId: task.id,
          injazTaskId: injazId,
          syncState: 'synced',
          lastSyncedAt: new Date(),
          syncError: null,
        });
        await setProposedTaskSynced(db, task.id);

        results.push({
          proposedTaskId: task.id,
          status: syncMode === 'updated' ? 'updated' : 'synced',
          injazTaskId: injazId,
        });
        log.info('cron.sync-approved-injaz.synced', {
          proposedTaskId: task.id,
          injazTaskId: injazId,
          mode: syncMode,
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
