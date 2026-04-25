import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  approvalEvents,
  eq,
  getDb,
  proposedTasks,
  sessions,
  sql,
} from '@nexus/db';
import { verifyDeviceBearer } from '@/lib/auth/device';
import { inngest } from '@/lib/inngest';
import { log } from '@/lib/logger';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';

/**
 * POST /api/approvals/:id/action
 * Auth: device bearer.
 * Body: { action: 'approve' | 'reject' | 'edit', reason?, title?, description? }
 *
 * Mirrors the web server actions but exposed for mobile/Telegram bot.
 * Records an approval_events row tagged with `actor_surface=mobile`.
 * Rate limited to prevent abuse.
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), reason: z.string().optional() }),
  z.object({
    action: z.literal('edit'),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
  }),
]);

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Rate limiting for device endpoint
  const rateLimit = checkRateLimit(req, strictRateLimiter);
  if (!rateLimit.allowed) {
    log.warn('approval.action.rate_limited');
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } }
    );
  }

  const device = await verifyDeviceBearer(req.headers.get('authorization'));
  if (!device) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: taskId } = await params;
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  const db = getDb();

  if (body.action === 'approve') {
    const [row] = await db
      .update(proposedTasks)
      .set({ state: 'approved', updatedAt: sql`now()` })
      .where(eq(proposedTasks.id, taskId))
      .returning();
    if (!row) return NextResponse.json({ error: 'task_not_found' }, { status: 404 });
    await db.insert(approvalEvents).values({
      proposedTaskId: taskId,
      actorSurface: 'mobile',
      actorDeviceId: device.id,
      action: 'approved',
    });
    await inngest.send({
      name: 'nexus/injaz.sync.requested',
      data: { proposedTaskId: taskId },
    });
    await maybeAdvanceSessionState(row.sessionId);
    log.info('approval.mobile.approve', { taskId, deviceId: device.id });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'reject') {
    const [row] = await db
      .update(proposedTasks)
      .set({ state: 'rejected', updatedAt: sql`now()` })
      .where(eq(proposedTasks.id, taskId))
      .returning();
    if (!row) return NextResponse.json({ error: 'task_not_found' }, { status: 404 });
    await db.insert(approvalEvents).values({
      proposedTaskId: taskId,
      actorSurface: 'mobile',
      actorDeviceId: device.id,
      action: 'rejected',
      payload: body.reason ? { reason: body.reason } : undefined,
    });
    await maybeAdvanceSessionState(row.sessionId);
    log.info('approval.mobile.reject', { taskId, deviceId: device.id });
    return NextResponse.json({ ok: true });
  }

  // edit + auto-approve
  const [row] = await db
    .update(proposedTasks)
    .set({
      title: body.title,
      description: body.description,
      state: 'approved',
      updatedAt: sql`now()`,
    })
    .where(eq(proposedTasks.id, taskId))
    .returning();
  if (!row) return NextResponse.json({ error: 'task_not_found' }, { status: 404 });
  await db.insert(approvalEvents).values({
    proposedTaskId: taskId,
    actorSurface: 'mobile',
    actorDeviceId: device.id,
    action: 'edited',
    payload: { title: body.title, description: body.description },
  });
  await db.insert(approvalEvents).values({
    proposedTaskId: taskId,
    actorSurface: 'mobile',
    actorDeviceId: device.id,
    action: 'approved',
  });
  await inngest.send({
    name: 'nexus/injaz.sync.requested',
    data: { proposedTaskId: taskId },
  });
  await maybeAdvanceSessionState(row.sessionId);
  log.info('approval.mobile.edit_approve', { taskId, deviceId: device.id });
  return NextResponse.json({ ok: true });
}
