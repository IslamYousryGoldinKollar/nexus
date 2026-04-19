import { desc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  approvedTasks,
  proposedTasks,
  type ApprovedTask,
  type NewApprovedTask,
  type ProposedTask,
} from '../schema/reasoning.js';

/**
 * Approved-task mirror queries for Phase 6 Injaz sync.
 *
 * `approved_tasks` is one-row-per-proposed-task, set up at first sync.
 * `injazTaskId` is filled in once the upstream call succeeds.
 * Drift detection (Phase 6+) reads `lastSyncedAt` to decide which rows
 * to re-poll.
 */

export async function getApprovedTaskByProposed(
  db: Database,
  proposedTaskId: string,
): Promise<ApprovedTask | null> {
  const [row] = await db
    .select()
    .from(approvedTasks)
    .where(eq(approvedTasks.proposedTaskId, proposedTaskId))
    .limit(1);
  return row ?? null;
}

export async function upsertApprovedTask(
  db: Database,
  row: NewApprovedTask,
): Promise<ApprovedTask> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(approvedTasks)
      .where(eq(approvedTasks.proposedTaskId, row.proposedTaskId))
      .limit(1);
    if (existing) {
      const [updated] = await tx
        .update(approvedTasks)
        .set({
          injazTaskId: row.injazTaskId ?? existing.injazTaskId,
          syncState: row.syncState ?? existing.syncState,
          lastSyncedAt: row.lastSyncedAt ?? existing.lastSyncedAt,
          syncError: row.syncError ?? null,
        })
        .where(eq(approvedTasks.id, existing.id))
        .returning();
      if (!updated) throw new Error('approved_task update returned no rows');
      return updated;
    }
    const [created] = await tx.insert(approvedTasks).values(row).returning();
    if (!created) throw new Error('approved_task insert returned no rows');
    return created;
  });
}

export async function getProposedTaskById(
  db: Database,
  id: string,
): Promise<ProposedTask | null> {
  const [row] = await db
    .select()
    .from(proposedTasks)
    .where(eq(proposedTasks.id, id))
    .limit(1);
  return row ?? null;
}

export async function setProposedTaskSynced(
  db: Database,
  id: string,
): Promise<void> {
  await db
    .update(proposedTasks)
    .set({ state: 'synced' })
    .where(eq(proposedTasks.id, id));
}

export async function listApprovedTasksDueForDriftCheck(
  db: Database,
  limit = 50,
): Promise<ApprovedTask[]> {
  // Phase 11 will filter by last-checked timestamp and rate-limit.
  return db
    .select()
    .from(approvedTasks)
    .where(eq(approvedTasks.syncState, 'synced'))
    .orderBy(desc(approvedTasks.lastSyncedAt))
    .limit(limit);
}
