import { jwtVerify, SignJWT } from 'jose';
import { cookies } from 'next/headers';

/**
 * JWT-cookie session.
 *
 * - Algorithm: HS256 with AUTH_SECRET (server-only)
 * - Cookie: httpOnly, secure (in prod), sameSite=lax, path=/, 7-day TTL
 * - Payload: { email, role, exp }
 *
 * Refresh strategy: on every authed request the middleware re-issues
 * the cookie if more than 50% of the TTL has elapsed. This way a tab
 * left open over a weekend stays signed in.
 */

const COOKIE_NAME = 'nexus_session';
const SESSION_TTL_DAYS = 7;
const SESSION_TTL_SEC = SESSION_TTL_DAYS * 24 * 60 * 60;

export interface SessionPayload {
  email: string;
  role: 'admin';
  iat: number;
  exp: number;
}

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_SECRET missing or too short (min 16 chars)');
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionJwt(email: string): Promise<string> {
  return new SignJWT({ email: email.toLowerCase(), role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(getSecretKey());
}

export async function verifySessionJwt(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify<SessionPayload>(token, getSecretKey(), {
      algorithms: ['HS256'],
    });
    return payload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(jwt: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const jwt = store.get(COOKIE_NAME)?.value;
  if (!jwt) return null;
  return verifySessionJwt(jwt);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
