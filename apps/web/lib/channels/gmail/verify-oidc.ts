import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Verify a Google-issued OIDC JWT attached to a Pub/Sub push request.
 *
 * Google sends the token in `Authorization: Bearer <jwt>`. It is signed
 * with Google's public keys and attests the identity of the Pub/Sub
 * service agent, so we can be sure the push came from Google.
 *
 * Reference: https://cloud.google.com/pubsub/docs/push#authentication
 *
 * Steps:
 *   1. RS256 verify against https://www.googleapis.com/oauth2/v3/certs (JWKS)
 *   2. iss === "https://accounts.google.com"
 *   3. aud === the audience we configured when creating the subscription
 *      (typically our webhook URL)
 *   4. exp > now
 *   5. email matches the service account we configured (optional hardening)
 */

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

// Cached across warm lambda invocations.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  return _jwks;
}

export interface VerifiedPubsubToken {
  email: string;
  emailVerified: boolean;
  claims: JWTPayload;
}

export class PubsubJwtError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'PubsubJwtError';
  }
}

export async function verifyPubsubOidcToken(args: {
  token: string;
  expectedAudience: string;
  expectedServiceAccountEmail?: string;
}): Promise<VerifiedPubsubToken> {
  const { token, expectedAudience, expectedServiceAccountEmail } = args;

  if (!token || typeof token !== 'string') {
    throw new PubsubJwtError('Missing bearer token', 'missing_token');
  }

  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, jwks(), {
      issuer: GOOGLE_ISSUER,
      audience: expectedAudience,
      algorithms: ['RS256'],
    });
    payload = res.payload;
  } catch (err) {
    throw new PubsubJwtError(
      `JWT verification failed: ${(err as Error).message}`,
      'verify_failed',
    );
  }

  const email = typeof payload.email === 'string' ? payload.email : '';
  const emailVerified =
    typeof payload.email_verified === 'boolean' ? payload.email_verified : false;

  if (!email) {
    throw new PubsubJwtError('JWT missing email claim', 'no_email');
  }
  if (!emailVerified) {
    throw new PubsubJwtError('JWT email not verified', 'email_unverified');
  }

  if (
    expectedServiceAccountEmail &&
    email.toLowerCase() !== expectedServiceAccountEmail.toLowerCase()
  ) {
    throw new PubsubJwtError(
      `JWT email mismatch: got ${email}, expected ${expectedServiceAccountEmail}`,
      'email_mismatch',
    );
  }

  return { email, emailVerified, claims: payload };
}
