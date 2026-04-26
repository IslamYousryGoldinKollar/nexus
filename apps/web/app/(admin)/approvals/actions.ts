'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  approvalEvents,
  eq,
  getDb,
  proposedTasks,
  sessions,
  sql,
} from '@nexus/db';
import { readSession } from '@/lib/auth/session';
import { log } from '@/lib/logger';
import { inngest } from '@/lib/inngest';

/**
 * Approve / reject / edit-then-approve a proposed task from the web UI.
 *
 * Audit trail lives in `approval_events` — proposed_tasks itself only
 * carries state + final content. When all tasks for a session reach a
 * terminal state we transition the session.
 *
 * Approved tasks emit `nexus/injaz.sync.requested` so Phase 6 can sync
 * them out. Same event id stable across phases so adding the handler
 * later doesn't double-sync.
 */

const taskIdSchema = z.string().uuid();

async function ensureAdmin(): Promise<{ email: string }> {
  const session = await readSession();
  if (!session) throw new Error('not_authenticated');
  return { email: session.email };
}

async function maybeAdvanceSessionState(sessionId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ state: proposedTasks.state })
    .from(proposedTasks)
    .where(eq(proposedTasks.sessionId, sessionId));

  if (rows.length === 0) return;
  const allTerminal = rows.every(
    (r) => r.state === 'approved' || r.state === 'rejected' || r.state === 'synced',
  );
  if (!allTerminal) return;

  const anyApproved = rows.some((r) => r.state === 'approved' || r.state === 'synced');
  await db
    .update(sessions)
    .set({
      state: anyApproved ? 'approved' : 'rejected',
      closedAt: new Date(),
      updatedAt: sql`now()`,
    })
    .where(eq(sessions.id, sessionId));
}

async function recordApprovalEvent(args: {
  proposedTaskId: string;
  email: string;
  action: 'approved' | 'rejected' | 'edited';
  payload?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db.insert(approvalEvents).values({
    proposedTaskId: args.proposedTaskId,
    actorSurface: 'web',
    actorUserId: null,
    action: args.action,
    payload: { adminEmail: args.email, ...args.payload },
  });
}

export async function approveTask(formData: FormData): Promise<void> {
  const admin = await ensureAdmin();
  const taskId = taskIdSchema.parse(formData.get('taskId'));
  // Optional assignee picked from the Injaz user dropdown. Empty string
  // = "no override" — sync falls back to the AI's assigneeGuess.
  const assignee = ((formData.get('assigneeInjazUserName') as string | null) ?? '').trim();

  const db = getDb();
  const [row] = await db
    .update(proposedTasks)
    .set({
      state: 'approved',
      assigneeInjazUserName: assignee.length > 0 ? assignee : null,
      updatedAt: sql`now()`,
    })
    .where(eq(proposedTasks.id, taskId))
    .returning();
  if (!row) throw new Error('task_not_found');

  await recordApprovalEvent({
    proposedTaskId: taskId,
    email: admin.email,
    action: 'approved',
    payload: assignee ? { assigneeInjazUserName: assignee } : undefined,
  });

  // Fire-and-forget Injaz sync trigger (Phase 6 will subscribe).
  await inngest.send({
    name: 'nexus/injaz.sync.requested',
    data: { proposedTaskId: taskId },
  });

  log.info('approval.approve', { taskId, by: admin.email });
  await maybeAdvanceSessionState(row.sessionId);
  revalidatePath('/approvals');
  revalidatePath('/dashboard');
}

export async function rejectTask(formData: FormData): Promise<void> {
  const admin = await ensureAdmin();
  const taskId = taskIdSchema.parse(formData.get('taskId'));
  const reason = ((formData.get('reason') as string | null) ?? '').trim() || null;

  const db = getDb();
  const [row] = await db
    .update(proposedTasks)
    .set({ state: 'rejected', updatedAt: sql`now()` })
    .where(eq(proposedTasks.id, taskId))
    .returning();
  if (!row) throw new Error('task_not_found');

  await recordApprovalEvent({
    proposedTaskId: taskId,
    email: admin.email,
    action: 'rejected',
    payload: reason ? { reason } : undefined,
  });

  log.info('approval.reject', { taskId, by: admin.email, reason });
  await maybeAdvanceSessionState(row.sessionId);
  revalidatePath('/approvals');
  revalidatePath('/dashboard');
}

export async function editAndApproveTask(formData: FormData): Promise<void> {
  const admin = await ensureAdmin();
  const taskId = taskIdSchema.parse(formData.get('taskId'));
  const title = ((formData.get('title') as string | null) ?? '').trim();
  const description = ((formData.get('description') as string | null) ?? '').trim();
  if (!title || !description) throw new Error('invalid_payload');

  const db = getDb();
  const [row] = await db
    .update(proposedTasks)
    .set({ title, description, state: 'approved', updatedAt: sql`now()` })
    .where(eq(proposedTasks.id, taskId))
    .returning();
  if (!row) throw new Error('task_not_found');

  await recordApprovalEvent({
    proposedTaskId: taskId,
    email: admin.email,
    action: 'edited',
    payload: { title, description },
  });
  await recordApprovalEvent({
    proposedTaskId: taskId,
    email: admin.email,
    action: 'approved',
  });

  await inngest.send({
    name: 'nexus/injaz.sync.requested',
    data: { proposedTaskId: taskId },
  });

  log.info('approval.edit_approve', { taskId, by: admin.email });
  await maybeAdvanceSessionState(row.sessionId);
  revalidatePath('/approvals');
  revalidatePath('/dashboard');
}
