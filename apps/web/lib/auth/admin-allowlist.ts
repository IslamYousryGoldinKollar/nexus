import { serverEnv } from '../env.js';

/**
 * Admin allowlist check. ADMIN_ALLOWED_EMAILS is parsed once into a
 * lowercased array in the env schema; we just compare.
 *
 * Centralized so the same predicate can be called from sign-in
 * (reject early), middleware (logout invalid sessions), and Telegram
 * fallback (Phase 9) without duplicating the rule.
 */
export function isAllowedAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = serverEnv.ADMIN_ALLOWED_EMAILS;
  return allowed.includes(email.toLowerCase());
}
