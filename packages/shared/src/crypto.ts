/**
 * Runtime-agnostic webhook-signature helpers.
 *
 * Uses Web Crypto (`globalThis.crypto.subtle`) which is available on:
 *   · Node 20 LTS (webcrypto global)
 *   · Vercel Edge runtime
 *   · Browsers
 *
 * No Node-only imports here — keep this package transpilable anywhere.
 */

export type HmacAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

const encoder = /* @__PURE__ */ new TextEncoder();

/**
 * Constant-time comparison of two equal-length byte sequences.
 *
 * Returns false as early as possible on length mismatch (lengths are not
 * secret), and otherwise iterates the full length regardless of mismatches
 * to avoid leaking information via timing side channels.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Convert a lower-case hex string (no `0x` prefix) to bytes. Invalid input → empty. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0) return new Uint8Array(0);
  if (!/^[0-9a-f]*$/.test(clean)) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Convert bytes to a lower-case hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/** Compute the HMAC of `body` under `secret` and return the raw bytes. */
export async function hmac(
  secret: string,
  body: Uint8Array | string,
  algorithm: HmacAlgorithm = 'SHA-256',
): Promise<Uint8Array> {
  const keyData = encoder.encode(secret);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    // Some TS lib configs narrow Uint8Array to Uint8Array<ArrayBufferLike>,
    // which isn't assignable to BufferSource. Cast keeps runtime correct
    // and avoids forcing every downstream package to upgrade its lib.
    keyData as unknown as ArrayBuffer,
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );
  const payload = typeof body === 'string' ? encoder.encode(body) : body;
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    payload as unknown as ArrayBuffer,
  );
  return new Uint8Array(sig);
}

/**
 * Verify an HMAC signature in hex format against the given body + secret.
 *
 * @param secret     the shared secret used to sign the body
 * @param body       the exact raw request body (Uint8Array or string)
 * @param signature  the received signature — HEX string, optionally prefixed
 *                   with `sha256=` / `sha1=` (Meta-style)
 * @param algorithm  hash algorithm, defaults to SHA-256
 * @returns          true iff the signature is valid. Never throws on bad input;
 *                   returns false for malformed signatures.
 */
export async function verifyHmac(
  secret: string,
  body: Uint8Array | string,
  signature: string,
  algorithm: HmacAlgorithm = 'SHA-256',
): Promise<boolean> {
  if (!secret || !signature) return false;
  // Strip Meta-style "sha256=" / "sha1=" prefix if present.
  const hex = signature.includes('=') ? (signature.split('=', 2)[1] ?? '') : signature;
  const received = hexToBytes(hex);
  if (received.length === 0) return false;
  const expected = await hmac(secret, body, algorithm);
  return timingSafeEqual(received, expected);
}

/**
 * Safe header-value compare. Used for Telegram's `X-Telegram-Bot-Api-Secret-Token`.
 * Short-circuits on length mismatch; otherwise constant-time.
 */
export function safeStringEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  return timingSafeEqual(ab, bb);
}
