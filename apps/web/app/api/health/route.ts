import { NextResponse } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe. Returns 200 + build metadata.
 * Used by Vercel health checks and the mobile app for connectivity tests.
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'nexus-web',
    phase: 0,
    timestamp: new Date().toISOString(),
  });
}
