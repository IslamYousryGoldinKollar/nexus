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
      const from = typeof p.from === 'string' ? p.from : null;
      const wa = normalizeWaId(from);
      return wa ? { kind: 'whatsapp_wa_id', value: wa, displayHint: from ?? undefined } : null;
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
