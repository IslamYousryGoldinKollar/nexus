import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { getOrCreateRequestId } from '@/lib/request-id';
import { applySecurityHeaders } from '@/lib/security-headers';

/**
 * Edge middleware: gate (admin) routes behind a valid session cookie,
 * and apply baseline security headers to every response.
 *
 * Why a separate verify here instead of importing `readSession`?
 * Middleware runs in the Edge runtime and can't import node:crypto
 * (used by `lib/auth/tokens.ts`). We re-implement a thin JWT verify
 * with `jose` (Edge-compatible) and skip the DB lookup — the JWT alone
 * is enough to know if the user is authed; allowlist checks happen
 * inside server actions when actions matter.
 */

const SESSION_COOKIE_NAME = 'nexus_session';

const PUBLIC_PATHS = [
  '/',
  '/login',
  '/api/auth/sign-in',
  '/api/auth/verify',
  '/api/health',
  '/api/inngest',
  '/api/ingest',
  '/api/admin',
  '/api/cron',
  '/_next',
  '/favicon.ico',
];

function isPublic(pathname: string): boolean {
  // Exact match for `/` so it doesn't swallow every other path.
  if (pathname === '/') return true;
  return PUBLIC_PATHS.some((p) => p !== '/' && (pathname === p || pathname.startsWith(`${p}/`)));
}

async function isValidSession(jwt: string | undefined): Promise<boolean> {
  if (!jwt) return false;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  try {
    await jwtVerify(jwt, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    return true;
  } catch {
    return false;
  }
}

function withHeaders(req: NextRequest, response: NextResponse, requestId: string): NextResponse {
  // Echo the request id back to the client + downstream handlers can read
  // it from `request.headers.get('x-request-id')` and pass it to
  // runWithRequestId() to get auto-tagged log events.
  response.headers.set('x-request-id', requestId);
  return applySecurityHeaders(response);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const requestId = getOrCreateRequestId(req.headers);

  // Forward x-request-id to the downstream handler so it can pick it up.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-request-id', requestId);
  const passthrough = NextResponse.next({ request: { headers: requestHeaders } });

  if (isPublic(pathname)) return withHeaders(req, passthrough, requestId);

  const jwt = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const ok = await isValidSession(jwt);
  if (ok) return withHeaders(req, passthrough, requestId);

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', pathname);
  return withHeaders(req, NextResponse.redirect(loginUrl), requestId);
}

export const config = {
  // Run on everything except static assets the browser fetches itself.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
