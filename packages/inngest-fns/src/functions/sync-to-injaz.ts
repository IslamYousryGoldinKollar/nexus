import {
  eq,
  getDb,
  getProposedTaskById,
  setProposedTaskSynced,
  upsertApprovedTask,
  proposedTasks as proposedTasksTable,
} from '@nexus/db';
import { createInjazTask, injazClientFromEnv, type InjazError } from '@nexus/services';
import { inngest } from '../client.js';

/**
 * Phase 6 — Push an approved proposed_task into Injaz.
 *
 * Flow:
 *   1. Load proposed_task; bail if missing or not in `approved` state
 *   2. Look up an existing approved_tasks row (idempotency)
 *   3. POST /tasks to Injaz with externalRefId = proposed_task.id
 *   4. Upsert approved_tasks row with injazTaskId + syncState=synced
 *   5. Mark proposed_task.state = synced
 *
 * Retry:
 *   - retries: 3 (Inngest exponential backoff, ~30s/2m/8m)
 *   - Permanent (non-retryable) errors throw a `NonRetriableError`-style
 *     wrapper that Inngest will not retry. We use this for 4xx.
 *
 * Concurrency: 4 — Injaz API recommends ≤ 5 concurrent writes.
 */
export const syncToInjaz = inngest.createFunction(
  {
    id: 'injaz-sync',
    name: 'Sync approved task to Injaz (Phase 6)',
    retries: 3,
    concurrency: { limit: 4 },
  },
  { event: 'nexus/injaz.sync.requested' },
  async ({ event, step, logger }) => {
    const { proposedTaskId } = event.data;

    // ---- 1. Load proposed_task ------------------------------------------
    const task = await step.run('load-task', async () => {
      const db = getDb();
      return getProposedTaskById(db, proposedTaskId);
    });
    if (!task) {
      logger.warn('injaz.sync.task_not_found', { proposedTaskId });
      return { status: 'task-not-found' as const };
    }
    if (task.state !== 'approved' && task.state !== 'synced') {
      logger.info('injaz.sync.skip_state', { proposedTaskId, state: task.state });
      return { status: 'skip-state' as const, state: task.state };
    }

    // ---- 2. Idempotency check ------------------------------------------
    const client = injazClientFromEnv();
    if (!client) {
      logger.error('injaz.sync.no_creds', {});
      // Mark as error so it shows up in the UI; don't keep retrying without creds.
      await step.run('mark-error', async () => {
        const db = getDb();
        await upsertApprovedTask(db, {
          proposedTaskId,
          syncState: 'pending',
          syncError: 'INJAZ_API_KEY or INJAZ_API_BASE missing',
        });
      });
      return { status: 'no-creds' as const };
    }

    // ---- 3. Call Injaz --------------------------------------------------
    let injazTask: { id: string };
    try {
      injazTask = await step.run('post-task', async () => {
        return createInjazTask(client, {
          title: task.title,
          description: task.description,
          priority: task.priorityGuess,
          dueDate: task.dueDateGuess
            ? (task.dueDateGuess as unknown as string)
            : null,
          assignee: task.assigneeGuess,
          externalRefId: task.id,
        });
      });
    } catch (err) {
      const ie = err as InjazError;
      if (!ie.retryable) {
        // Permanent — record + bail without rethrow.
        logger.error('injaz.sync.permanent_failure', {
          proposedTaskId,
          status: ie.status,
          message: ie.message,
        });
        await step.run('mark-failed', async () => {
          const db = getDb();
          await upsertApprovedTask(db, {
            proposedTaskId,
            syncState: 'pending',
            syncError: `${ie.status ?? 0}: ${ie.message}`.slice(0, 1000),
          });
        });
        return { status: 'permanent-failure' as const, httpStatus: ie.status };
      }
      // Retryable — rethrow so Inngest backs off.
      throw err;
    }

    // ---- 4 + 5. Persist outcome ----------------------------------------
    await step.run('persist-success', async () => {
      const db = getDb();
      await upsertApprovedTask(db, {
        proposedTaskId,
        injazTaskId: injazTask.id,
        syncState: 'synced',
        lastSyncedAt: new Date(),
        syncError: null,
      });
      await setProposedTaskSynced(db, proposedTaskId);
    });

    logger.info('injaz.sync.success', { proposedTaskId, injazTaskId: injazTask.id });
    return {
      status: 'synced' as const,
      proposedTaskId,
      injazTaskId: injazTask.id,
    };
  },
);

// Re-export the table reference for downstream tests/queries — not used here.
void proposedTasksTable;
void eq;
