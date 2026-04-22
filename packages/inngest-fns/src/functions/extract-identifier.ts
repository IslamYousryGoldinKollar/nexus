import type { Channel, IdentifierKind } from '@nexus/shared';
import { normalizeEmail, normalizeHandle, normalizePhone, normalizeWaId } from '@nexus/shared';

/**
 * Extract a normalized identifier from a channel-specific `raw_payload`.
 *
 * We intentionally look up inside the blob rather than requiring each
 * channel ingester to pre-normalize, because:
 *   1. `raw_payload` is the canonical source of truth
 *   2. rerunning resolution after a schema bump becomes trivial — just
 *      replay `nexus/interaction.ingested`
 *
 * Returns null when we cannot derive a stable identifier for this
 * payload (shouldn't happen in Phase 1 inputs, but be defensive).
 */
export function extractIdentifier(
  channel: Channel,
  rawPayload: unknown,
  sourceMessageId?: string,
): { kind: IdentifierKind; value: string; displayHint?: string } | null {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const p = rawPayload as Record<string, unknown>;

  switch (channel) {
    case 'whatsapp': {
      // Two WhatsApp shapes land here:
      //   - Meta Cloud webhook: `from` is a clean digit-only wa_id (e.g. "201234567890")
      //   - Baileys bridge: `from` is a JID like
      //       "<digits>@s.whatsapp.net"   — a real phone-bearing address
      //       "<digits>@lid"              — pseudonymous Linked-ID (not a phone!)
      //       "<digits>@g.us"             — group address (also not a phone)
      //     In the @lid case Baileys also exposes `raw.key.senderPn` with the
      //     sender's real E.164 address when WA chose to reveal it, plus
      //     `raw.pushName` (human display name).
      //
      // Resolution order:
      //   1. `raw.key.senderPn`         ← best: verified phone
      //   2. `raw.key.remoteJid` unless @lid/@g.us/@broadcast
      //   3. `from`                    unless @lid/@g.us/@broadcast
      //   4. Fallback: use the raw `@lid` digits as a stable pseudonymous
      //      identifier so we still get a contact + session + transcription.
      const raw = (p.raw as Record<string, unknown> | undefined) ?? null;
      const key = (raw?.key as Record<string, unknown> | undefined) ?? null;
      const senderPn = typeof key?.senderPn === 'string' ? key.senderPn : null;
      const remoteJid = typeof key?.remoteJid === 'string' ? key.remoteJid : null;
      const pushName = typeof raw?.pushName === 'string' ? raw.pushName : null;
      const fromField = typeof p.from === 'string' ? p.from : null;

      // Strip `@<suffix>` and `:<device>` (e.g. "201110202550:25@s.whatsapp.net").
      const stripJid = (s: string | null): string | null => {
        if (!s) return null;
        const at = s.split('@')[0] ?? '';
        return (at.split(':')[0] ?? '') || null;
      };
      const isPhoneAddr = (s: string | null): s is string =>
        !!s && !s.includes('@lid') && !s.includes('@g.us') && !s.includes('@broadcast');

      for (const cand of [senderPn, remoteJid, fromField].filter(isPhoneAddr)) {
        const wa = normalizeWaId(stripJid(cand));
        if (wa) return { kind: 'whatsapp_wa_id', value: wa, displayHint: pushName ?? cand };
      }

      // Pseudonymous fallback: still identify, but signal non-phone with a `lid:` prefix
      // that will never collide with a real E.164 number.
      const lidSrc = remoteJid ?? fromField;
      const lidDigits = stripJid(lidSrc);
      if (lidDigits && lidDigits.length >= 7) {
        return {
          kind: 'whatsapp_wa_id',
          value: `lid:${lidDigits}`,
          displayHint: pushName ?? lidSrc ?? undefined,
        };
      }
      return null;
    }

    case 'telegram': {
      // Raw payload is a Message — `from.id` if DM, else chat.id
      const from = p.from as { id?: number | string; username?: string; first_name?: string } | undefined;
      const chat = p.chat as { id?: number | string; title?: string } | undefined;
      const id = from?.id ?? chat?.id;
      const handle = normalizeHandle(id);
      if (!handle) return null;
      const display =
        (from?.username && `@${from.username}`) ||
        from?.first_name ||
        chat?.title ||
        undefined;
      return { kind: 'telegram_user_id', value: handle, displayHint: display };
    }

    case 'phone': {
      // For phone, the ingester stores the counterparty inside rawPayload.
      const cp = typeof p.counterparty === 'string' ? p.counterparty : null;
      const phone = normalizePhone(cp);
      return phone ? { kind: 'phone', value: phone, displayHint: cp ?? undefined } : null;
    }

    case 'gmail': {
      // Gmail's raw payload is the Pub/Sub envelope. Real email metadata is
      // stored once the history API is polled (Phase 1.5+). For now look for
      // a `from` field if someone pre-populated it.
      const from = typeof p.from === 'string' ? p.from : null;
      const email = normalizeEmail(from);
      return email ? { kind: 'email', value: email, displayHint: from ?? undefined } : null;
    }

    case 'teams': {
      const from = p.from as { id?: string } | undefined;
      const handle = normalizeHandle(from?.id);
      return handle ? { kind: 'teams_user_id', value: handle } : null;
    }

    default:
      // Exhaustiveness guard — any future channel must be handled above.
      return sourceMessageId
        ? { kind: 'phone', value: sourceMessageId }
        : null;
  }
}
