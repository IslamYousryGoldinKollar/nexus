import {
  CHANNELS,
  type ContentType,
  type InteractionIngestedEvent,
} from '@nexus/shared';
import { insertAttachment, upsertInteraction } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { getDb } from '../../db';
import { log } from '../../logger';
import type { BaileysEnvelope, BaileysMessage } from './baileys-schema';

/**
 * Ingest a batch of Baileys-normalized messages.
 *
 * The Baileys bridge has already downloaded media and uploaded it to
 * Supabase Storage before calling us. Our job here is purely:
 *
 *   1. `upsertInteraction` keyed by the WhatsApp message id (idempotent)
 *   2. Record an attachment row pointing at the Supabase storage key,
 *      if the bridge reported media
 *   3. Emit `nexus/interaction.ingested` for downstream workers
 *
 * We intentionally mirror the contract of `ingestWhatsappWebhook` (Meta
 * Cloud) so sessionization / reasoning don't need to care which bridge
 * a message came in through.
 */

export interface BaileysOutcome {
  sourceMessageId: string;
  from: string;
  type: string;
  interactionId: string;
  inserted: boolean;
  attachmentId?: string;
  skipped?: 'outbound' | 'unsupported_type';
}

export async function ingestBaileysEnvelope(
  envelope: BaileysEnvelope,
): Promise<BaileysOutcome[]> {
  const outcomes: BaileysOutcome[] = [];
  for (const msg of envelope.messages) {
    try {
      outcomes.push(await ingestOne(msg));
    } catch (err) {
      log.error('whatsapp.baileys.ingest.message_failed', {
        id: msg.id,
        from: msg.from,
        type: msg.type,
        err: (err as Error).message,
      });
    }
  }
  return outcomes;
}

async function ingestOne(msg: BaileysMessage): Promise<BaileysOutcome> {
  // Skip messages we sent from the phone — those are outbound, handled
  // separately via our admin UI (they're the agent's own replies if any).
  if (msg.fromMe) {
    return {
      sourceMessageId: msg.id,
      from: msg.from,
      type: msg.type,
      interactionId: '',
      inserted: false,
      skipped: 'outbound',
    };
  }

  const derived = deriveContent(msg);
  if (!derived) {
    return {
      sourceMessageId: msg.id,
      from: msg.from,
      type: msg.type,
      interactionId: '',
      inserted: false,
      skipped: 'unsupported_type',
    };
  }

  const occurredAt = new Date(msg.timestamp * 1000);
  const db = getDb();

  const { interaction, inserted } = await upsertInteraction(db, {
    channel: CHANNELS[0], // 'whatsapp' — same channel, different bridge
    direction: 'inbound',
    contentType: derived.contentType,
    text: derived.text,
    sourceMessageId: msg.id,
    occurredAt,
    rawPayload: msg as unknown as Record<string, unknown>,
  });

  const outcome: BaileysOutcome = {
    sourceMessageId: msg.id,
    from: msg.from,
    type: msg.type,
    interactionId: interaction.id,
    inserted,
  };

  // Record attachment metadata if the bridge uploaded media.
  if (inserted && msg.media) {
    try {
      const attachment = await insertAttachment(db, {
        interactionId: interaction.id,
        r2Key: msg.media.storageKey, // column named r2Key historically; now holds Supabase key
        mimeType: msg.media.mimeType,
        sizeBytes: msg.media.sizeBytes,
        checksum: msg.media.checksumHex,
      });
      outcome.attachmentId = attachment.id;
      log.info('whatsapp.baileys.media.recorded', {
        interactionId: interaction.id,
        storageKey: msg.media.storageKey,
        sizeBytes: msg.media.sizeBytes,
      });
    } catch (err) {
      log.warn('whatsapp.baileys.attachment.insert_failed', {
        interactionId: interaction.id,
        err: (err as Error).message,
      });
    }
  }

  if (inserted) {
    const event: InteractionIngestedEvent = {
      name: 'nexus/interaction.ingested',
      data: {
        interactionId: interaction.id,
        channel: 'whatsapp',
        sourceMessageId: msg.id,
        occurredAt: occurredAt.toISOString(),
      },
    };
    try {
      await inngest.send(event);
    } catch (err) {
      log.warn('whatsapp.baileys.inngest.emit_failed', {
        interactionId: interaction.id,
        err: (err as Error).message,
      });
    }
  }

  return outcome;
}

interface Derived {
  contentType: ContentType;
  text: string | null;
}

function deriveContent(msg: BaileysMessage): Derived | null {
  switch (msg.type) {
    case 'text':
      return { contentType: 'text', text: msg.text ?? '' };
    case 'image':
    case 'sticker':
      return { contentType: 'image', text: msg.text };
    case 'audio':
      return { contentType: 'audio', text: null };
    case 'video':
      return { contentType: 'video', text: msg.text };
    case 'document':
      return { contentType: 'file', text: msg.text };
    case 'location': {
      if (!msg.location) return null;
      const parts = [
        msg.location.name ? `📍 ${msg.location.name}` : '📍',
        msg.location.address,
        `${msg.location.latitude.toFixed(6)}, ${msg.location.longitude.toFixed(6)}`,
      ].filter(Boolean);
      return { contentType: 'text', text: parts.join('\n') };
    }
    case 'contact':
    case 'unknown':
    default:
      return null;
  }
}
