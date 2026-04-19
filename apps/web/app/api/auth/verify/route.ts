import { NextResponse } from 'next/server';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { createSessionJwt, setSessionCookie } from '@/lib/auth/session';
import { verifyAndConsumeToken } from '@/lib/auth/tokens';
import { log } from '@/lib/logger';

/**
 * GET /api/auth/verify?token=xxx&next=/dashboard
 *
 * Single-use token claim. On success: set the session cookie and 302 to
 * the `next` query param (default /dashboard). On failure: 302 to
 * /login?error=expired_or_invalid.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const next = url.searchParams.get('next') ?? '/dashboard';

  if (!token) {
    return NextResponse.redirect(new URL('/login?error=missing_token', req.url));
  }

  const verified = await verifyAndConsumeToken(token);
  if (!verified) {
    log.warn('auth.verify.invalid', {});
    return NextResponse.redirect(new URL('/login?error=expired_or_invalid', req.url));
  }

  if (!isAllowedAdmin(verified.email)) {
    // Defense in depth: even if a token slipped through (allowlist could
    // have changed since it was issued), refuse to mint a session.
    log.warn('auth.verify.not_allowlisted', { email: verified.email });
    return NextResponse.redirect(new URL('/login?error=not_allowed', req.url));
  }

  const jwt = await createSessionJwt(verified.email);
  await setSessionCookie(jwt);
  log.info('auth.verify.success', { email: verified.email });

  // Sanitize `next` to prevent open-redirect.
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  return NextResponse.redirect(new URL(safeNext, req.url));
}
