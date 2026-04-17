/**
 * Identifier normalization utilities.
 *
 * Different channels hand us the same human identified differently:
 *   - WhatsApp gives a raw wa_id (digits only, no + prefix)
 *   - Telegram gives a numeric user_id AND sometimes a phone
 *   - Gmail gives an email (casing may vary)
 *   - Phone call metadata gives a locally-formatted phone number
 *
 * We normalize into a canonical form so `contact_identifiers.value` is
 * always directly comparable — no JOIN-time coercion.
 */

/**
 * Normalize a phone number into E.164-ish form:
 *   - strip everything that isn't a digit or leading `+`
 *   - require 7–15 digits (ITU-T E.164 range)
 *   - prefix `+` if missing
 *
 * Returns `null` for inputs we can't confidently normalize.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Keep leading + if present, strip everything else non-digit.
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length < 7 || digits.length > 15) return null;

  return hasPlus ? `+${digits}` : `+${digits}`;
}

/**
 * Same as `normalizePhone` but accepts the digit-only form WhatsApp uses
 * (e.g. `201234567890`). If the input has no leading `+` and starts with
 * a recognized country code prefix we still E.164 it.
 */
export function normalizeWaId(raw: string | null | undefined): string | null {
  return normalizePhone(raw);
}

/** Lower-case and trim an email. Returns null for obviously bad input. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = String(raw).trim().toLowerCase();
  if (!lower.includes('@') || lower.length < 3) return null;
  return lower;
}

/** Pass-through trim for platform user ids (Telegram/Teams). */
export function normalizeHandle(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s || null;
}
