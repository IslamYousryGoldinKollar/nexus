import { safeStringEqual } from '@nexus/shared';
import { serverEnv } from '../../env';

/**
 * Phase 1 phone-recorder authentication.
 *
 * We compare the bearer token against a comma-separated list of allowed
 * pre-shared keys stored in PHONE_INGEST_API_KEYS. Constant-time compare,
 * first-match short-circuit.
 *
 * Phase 7 replaces this with per-device API keys + HMAC-signed uploads
 * backed by the `devices` table.
 */
export function authorizePhoneUpload(req: Request): { ok: boolean; reason?: string } {
  const configured = serverEnv.PHONE_INGEST_API_KEYS;
  const allowed = configured
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    return { ok: false, reason: 'ingest_disabled' };
  }

  const authz = req.headers.get('authorization') ?? '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
  if (!bearer) {
    return { ok: false, reason: 'missing_bearer' };
  }

  const match = allowed.some((key) => safeStringEqual(key, bearer));
  return match ? { ok: true } : { ok: false, reason: 'key_mismatch' };
}
