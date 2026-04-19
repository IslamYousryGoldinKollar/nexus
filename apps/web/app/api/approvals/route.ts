import { NextResponse } from 'next/server';
import { verifyDeviceBearer } from '@/lib/auth/device';
import { loadAwaitingApprovals } from '@/lib/queries/approvals';

/**
 * GET /api/approvals
 *
 * Auth: device bearer.
 * Returns the awaiting-approval cards in a mobile-friendly shape.
 */
export async function GET(req: Request) {
  const device = await verifyDeviceBearer(req.headers.get('authorization'));
  if (!device) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const cards = await loadAwaitingApprovals(50);

  return NextResponse.json({
    deviceId: device.id,
    fetchedAt: new Date().toISOString(),
    items: cards.map((c) => ({
      sessionId: c.session.id,
      contactName: c.contactName,
      lastActivityAt: c.session.lastActivityAt,
      tasks: c.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        priority: t.priorityGuess,
        rationale: t.rationale,
        evidence: t.evidence,
        state: t.state,
      })),
    })),
  });
}
