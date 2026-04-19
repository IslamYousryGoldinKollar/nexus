import { sha256Hex } from '@nexus/shared';
import { findDeviceByApiKeyHash, getDb, touchDevice, type Device } from '@nexus/db';
import { randomBytes } from 'node:crypto';

/**
 * Device API-key lifecycle.
 *
 * Format:
 *   `nxd_` + 40 url-safe base64 chars (~30 bytes entropy)
 *   The prefix lets us spot-check headers in logs and grep keys in env.
 *
 * Stored as sha-256 hex in `devices.api_key_hash` (unique). Verifying a
 * request hashes the bearer header and looks up the row directly —
 * O(1) and constant-time-equivalent.
 *
 * Pairing codes are 6 alphanumeric chars (excluding 0/O/I/1 confusables).
 * Stored hashed too; user types or scans the plaintext.
 */

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/I/1

function urlSafeBase64(buf: Buffer): string {
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export function generateDeviceApiKey(): string {
  return `nxd_${urlSafeBase64(randomBytes(30)).slice(0, 40)}`;
}

export function generatePairingCode(): string {
  const buf = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += PAIRING_ALPHABET[(buf[i] ?? 0) % PAIRING_ALPHABET.length];
  }
  return out;
}

export async function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key);
}

export async function hashPairingCode(code: string): Promise<string> {
  // Normalize to upper-case so the user can type lower-case if they want.
  return sha256Hex(code.toUpperCase());
}

/**
 * Verify a `Authorization: Bearer nxd_...` header against the devices
 * table. Returns the device row on success, null on any failure (no
 * leakage of which step failed — same null for "no device" and
 * "revoked").
 */
export async function verifyDeviceBearer(
  authorizationHeader: string | null | undefined,
): Promise<Device | null> {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(nxd_[A-Za-z0-9_-]{20,})\s*$/i.exec(authorizationHeader);
  if (!m || !m[1]) return null;
  const key = m[1];
  const hash = await hashApiKey(key);
  const db = getDb();
  const device = await findDeviceByApiKeyHash(db, hash);
  if (!device) return null;
  // Fire-and-forget last-seen update; doesn't block the request.
  void touchDevice(db, device.id).catch(() => {});
  return device;
}
