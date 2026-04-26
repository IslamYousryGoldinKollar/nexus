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
  setProposedTaskSynced,
  upsertApprovedTask,
} from '@nexus/db';
import { createInjazTask, injazClientFromEnv, type InjazError } from '@nexus/services';
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
    // The previous version only handled case (a), which left 9 tasks
    // permanently stuck after the REST→MCP migration.
    const pending = await db
      .select({
        id: proposedTasksTable.id,
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

    const results: Array<{
      proposedTaskId: string;
      status: string;
      injazTaskId?: string;
      error?: string;
    }> = [];

    for (const task of pending) {
      try {
        const injazTask = await createInjazTask(client, {
          title: task.title,
          description: task.description,
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
        // Persist the failure so the UI can show it; don't throw — keep
        // looping so one bad task doesn't block the rest.
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
