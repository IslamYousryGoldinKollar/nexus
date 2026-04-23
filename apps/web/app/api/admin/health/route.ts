import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Check for env parsing errors first
  let envLoadError: string | null = null;
  let serverEnv: typeof import('@nexus/shared').serverEnvSchema['_type'] | null = null;

  try {
    const { serverEnv: env } = await import('@/lib/env');
    serverEnv = env as unknown as typeof serverEnvSchema['_type'];
  } catch (err) {
    envLoadError = (err as Error).message;
  }

  if (envLoadError) {
    return NextResponse.json({
      ok: false,
      error: 'ENV_LOAD_FAILED',
      message: envLoadError,
      rawEnv: {
        hasResendKey: !!process.env.RESEND_API_KEY,
        hasAuthSecret: !!process.env.AUTH_SECRET,
        hasAdminEmails: !!process.env.ADMIN_ALLOWED_EMAILS,
        hasAppUrl: !!process.env.APP_URL,
        hasDatabaseUrl: !!process.env.DATABASE_URL,
      },
    }, { status: 500 });
  }

  // Check critical env vars without exposing values
  const checks = {
    resendApiKey: {
      set: !!serverEnv?.RESEND_API_KEY,
      length: serverEnv?.RESEND_API_KEY?.length || 0,
      startsWith: serverEnv?.RESEND_API_KEY?.startsWith('re_') || false,
    },
    authSecret: {
      set: !!process.env.AUTH_SECRET,
      length: process.env.AUTH_SECRET?.length || 0,
    },
    adminAllowedEmails: {
      set: !!process.env.ADMIN_ALLOWED_EMAILS,
      parsed: serverEnv?.ADMIN_ALLOWED_EMAILS,
      count: serverEnv?.ADMIN_ALLOWED_EMAILS?.length || 0,
    },
    appUrl: {
      set: !!serverEnv?.APP_URL,
      value: serverEnv?.APP_URL,
    },
    resendFromEmail: {
      set: !!serverEnv?.RESEND_FROM_EMAIL,
      value: serverEnv?.RESEND_FROM_EMAIL,
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
