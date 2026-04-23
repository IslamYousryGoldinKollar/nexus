import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sendMagicLinkEmail } from '@nexus/services';
import { isAllowedAdmin } from '@/lib/auth/admin-allowlist';
import { createMagicLinkToken } from '@/lib/auth/tokens';
import { serverEnv } from '@/lib/env';
import { log } from '@/lib/logger';

/**
 * POST /api/auth/sign-in { email }
 *
 * - Always responds 200 OK regardless of whether the email is on the
 *   allowlist (don't leak who has access).
 * - Only sends an email if the address IS on the allowlist.
 * - Rate limit: not implemented in Phase 5; relies on admin email being
 *   secret. Phase 11 wires Upstash sliding-window per-IP.
 */

const bodySchema = z.object({
  email: z.string().email().toLowerCase(),
});

export async function POST(req: Request) {
  try {
    let body: { email: string };
    try {
      body = bodySchema.parse(await req.json());
    } catch {
      return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
    }

    const allowed = isAllowedAdmin(body.email);
    if (!allowed) {
      log.warn('auth.sign_in.not_allowlisted', { email: body.email });
      // Same 200 to avoid enumeration.
      return NextResponse.json({ ok: true });
    }

    if (!serverEnv.RESEND_API_KEY) {
      log.error('auth.sign_in.no_resend_key', {});
      return NextResponse.json({ error: 'server_misconfigured' }, { status: 500 });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const ua = req.headers.get('user-agent') ?? null;

    const { token } = await createMagicLinkToken({
      email: body.email,
      ip: ip ?? undefined,
      userAgent: ua ?? undefined,
    });

    const verifyUrl = new URL('/api/auth/verify', serverEnv.APP_URL);
    verifyUrl.searchParams.set('token', token);

    await sendMagicLinkEmail(serverEnv.RESEND_API_KEY, {
      to: body.email,
      url: verifyUrl.toString(),
      from: serverEnv.RESEND_FROM_EMAIL,
    });

    log.info('auth.sign_in.email_sent', { email: body.email });
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.error('auth.sign_in.unexpected_error', { error: (err as Error).message, stack: (err as Error).stack });
    return NextResponse.json({ error: 'internal_error', message: (err as Error).message }, { status: 500 });
  }
}
