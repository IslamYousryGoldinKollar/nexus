import { safeStringEqual } from '@nexus/shared';
import { verifyDeviceBearer } from '../../auth/device';
import { serverEnv } from '../../env';

/**
 * Phone-recorder authentication.
 *
 * Two equally-trusted credential paths:
 *
 *   1. **Per-device key** — the Android UploadRecordingWorker sends the
 *      device API key it received from /api/devices/pair-claim. The
 *      `devices` table holds the SHA-256 of that key; we look it up via
 *      verifyDeviceBearer. This is the right path now that pairing is
 *      live; it scopes credentials per device, supports revocation, and
 *      doesn't require operator-managed pre-shared keys.
 *
 *   2. **Pre-shared key in PHONE_INGEST_API_KEYS env** — older flow,
 *      kept as a fallback for ad-hoc curl uploads or for clients that
 *      pre-date pairing. Constant-time compare against the comma list.
 *
 * Returns { ok: true } if either path passes.
 */
export async function authorizePhoneUpload(req: Request): Promise<{ ok: boolean; reason?: string }> {
  const authz = req.headers.get('authorization') ?? '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
  if (!bearer) {
    return { ok: false, reason: 'missing_bearer' };
  }

  // Path 1: per-device key (preferred).
  // verifyDeviceBearer accepts the full "Bearer <key>" header so pass it through.
  try {
    const device = await verifyDeviceBearer(authz);
    if (device) return { ok: true };
  } catch {
    // fall through to pre-shared check
  }

  // Path 2: pre-shared keys.
  const configured = serverEnv.PHONE_INGEST_API_KEYS;
  const allowed = configured
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (allowed.length > 0) {
    const match = allowed.some((key) => safeStringEqual(key, bearer));
    if (match) return { ok: true };
  }

  return { ok: false, reason: 'key_mismatch' };
}
