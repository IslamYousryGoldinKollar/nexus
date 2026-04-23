import { NextResponse } from 'next/server';
import { serverEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Check critical env vars without exposing values
  const checks = {
    resendApiKey: {
      set: !!serverEnv.RESEND_API_KEY,
      length: serverEnv.RESEND_API_KEY?.length || 0,
      startsWith: serverEnv.RESEND_API_KEY?.startsWith('re_') || false,
    },
    authSecret: {
      set: !!process.env.AUTH_SECRET,
      length: process.env.AUTH_SECRET?.length || 0,
    },
    adminAllowedEmails: {
      set: !!process.env.ADMIN_ALLOWED_EMAILS,
      parsed: serverEnv.ADMIN_ALLOWED_EMAILS,
      count: serverEnv.ADMIN_ALLOWED_EMAILS?.length || 0,
    },
    appUrl: {
      set: !!serverEnv.APP_URL,
      value: serverEnv.APP_URL,
    },
    resendFromEmail: {
      set: !!serverEnv.RESEND_FROM_EMAIL,
      value: serverEnv.RESEND_FROM_EMAIL,
    },
    databaseUrl: {
      set: !!process.env.DATABASE_URL,
      hasPassword: process.env.DATABASE_URL?.includes(':') || false,
    },
  };

  // Test database connection
  let dbStatus = 'unknown';
  try {
    const { getDb } = await import('@nexus/db');
    const db = getDb();
    await db.execute('SELECT 1');
    dbStatus = 'connected';
  } catch (err) {
    dbStatus = `error: ${(err as Error).message}`;
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV,
    checks,
    dbStatus,
  }, { status: 200 });
}
