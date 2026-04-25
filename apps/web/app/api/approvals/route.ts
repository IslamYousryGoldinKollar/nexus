import { NextResponse, type NextRequest } from 'next/server';
import { verifyDeviceBearer } from '@/lib/auth/device';
import { loadAwaitingApprovals } from '@/lib/queries/approvals';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

/**
 * GET /api/approvals
 *
 * Auth: device bearer.
 * Returns the awaiting-approval cards in a mobile-friendly shape.
 * Rate limited to prevent abuse.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for device endpoint
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('approvals.rate_limited');
      return NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }

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
  });
}
