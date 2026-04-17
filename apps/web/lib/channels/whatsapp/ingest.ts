import {
  CHANNELS,
  type ContentType,
  type InteractionIngestedEvent,
} from '@nexus/shared';
import { insertAttachment, upsertInteraction } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { getDb } from '../../db';
import { log } from '../../logger';
import { uploadToR2 } from '../../r2';
import { downloadMedia, WhatsappMediaError } from './media';
import {
  type WhatsappMessage,
  type WhatsappWebhookPayload,
} from './schema';

/**
 * Per-message ingestion outcome. Used by the route handler to build an
 * audit log line without leaking PII.
 */
export interface IngestOutcome {
  sourceMessageId: string;
  from: string;
  type: string;
  interactionId: string;
  inserted: boolean;
  attachmentId?: string;
  skipped?: 'status_update' | 'unsupported_type' | 'reaction' | 'media_download_failed';
}

interface IngestContext {
  receivedAt: Date;
  phoneNumberId?: string;
}

/**
 * Walk every `entry → changes → messages` in the payload and persist each.
 *
 * Never throws on a single bad message — logs + continues, so a single
 * malformed item can't poison the whole batch (Meta sends batches of up
 * to ~100 messages during backfills).
 */
export async function ingestWhatsappWebhook(
  payload: WhatsappWebhookPayload,
  ctx: IngestContext = { receivedAt: new Date() },
): Promise<IngestOutcome[]> {
  const outcomes: IngestOutcome[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const { value } = change;
      const phoneNumberId = value.metadata.phone_number_id;
      const innerCtx = { ...ctx, phoneNumberId };

      // Status updates (delivered/read/failed) — ignore in Phase 1.
      if (value.statuses && value.statuses.length > 0) {
        for (const s of value.statuses) {
          outcomes.push({
            sourceMessageId: s.id,
            from: s.recipient_id ?? '',
            type: `status:${s.status}`,
            interactionId: '',
            inserted: false,
            skipped: 'status_update',
          });
        }
      }

      if (value.messages) {
        for (const msg of value.messages) {
          try {
            const outcome = await ingestOneMessage(msg, innerCtx);
            outcomes.push(outcome);
          } catch (err) {
            log.error('whatsapp.ingest.message_failed', {
              sourceMessageId: msg.id,
              from: msg.from,
              type: msg.type,
              err: (err as Error).message,
            });
            // Continue with the next message; Meta won't re-deliver only
            // the failed one, but at least the rest land.
          }
        }
      }
    }
  }

  return outcomes;
}

async function ingestOneMessage(
  msg: WhatsappMessage,
  _ctx: Required<Pick<IngestContext, 'receivedAt' | 'phoneNumberId'>>,
): Promise<IngestOutcome> {
  const occurredAt = new Date(Number(msg.timestamp) * 1000);
  const db = getDb();

  // --- Reactions: not an ingestion-worthy atom in Phase 1. ---
  if (msg.type === 'reaction') {
    return {
      sourceMessageId: msg.id,
      from: msg.from,
      type: msg.type,
      interactionId: '',
      inserted: false,
      skipped: 'reaction',
    };
  }

  // --- Derive our content_type + extracted text. ---
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
  const { contentType, text, mediaId, mediaMimeHint } = derived;

  // --- Persist the interaction first (idempotent by message id). ---
  // Media download happens AFTER the interaction row exists so retries can
  // resume uploading without duplicating the interaction.
  const { interaction, inserted } = await upsertInteraction(db, {
    channel: CHANNELS[0], // 'whatsapp'
    direction: 'inbound',
    contentType,
    text,
    sourceMessageId: msg.id,
    occurredAt,
    rawPayload: msg as unknown as Record<string, unknown>,
  });

  const outcome: IngestOutcome = {
    sourceMessageId: msg.id,
    from: msg.from,
    type: msg.type,
    interactionId: interaction.id,
    inserted,
  };

  // --- Download media if applicable + stable (idempotent) ---
  if (mediaId && inserted) {
    try {
      const media = await downloadMedia(mediaId);
      const mime = media.mimeType || mediaMimeHint || 'application/octet-stream';
      const uploaded = await uploadToR2({
        channel: 'whatsapp',
        bytes: media.bytes,
        mimeType: mime,
        occurredAt,
      });
      const attachment = await insertAttachment(db, {
        interactionId: interaction.id,
        r2Key: uploaded.key,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
        checksum: uploaded.checksumHex,
      });
      outcome.attachmentId = attachment.id;
      log.info('whatsapp.media.uploaded', {
        mediaId,
        sizeBytes: uploaded.sizeBytes,
        r2Key: uploaded.key,
        alreadyExisted: uploaded.alreadyExisted,
      });
    } catch (err) {
      // Never fail the ingestion on a media fetch; the interaction row is
      // safe and a backfill job can re-attempt the download later.
      outcome.skipped = 'media_download_failed';
      const ctx2: Record<string, unknown> = {
        mediaId,
        err: (err as Error).message,
      };
      if (err instanceof WhatsappMediaError && typeof err.status === 'number') {
        ctx2.status = err.status;
      }
      log.warn('whatsapp.media.download_failed', ctx2);
    }
  }

  // --- Emit the downstream event. ---
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
      log.warn('whatsapp.inngest.emit_failed', {
        interactionId: interaction.id,
        err: (err as Error).message,
      });
    }
  }

  return outcome;
}

interface DerivedContent {
  contentType: ContentType;
  text: string | null;
  mediaId?: string;
  mediaMimeHint?: string;
}

/**
 * Map WhatsApp's polymorphic message shape onto our normalized fields.
 * Returns `null` for types we intentionally drop in Phase 1.
 *
 * The intersection schema (`messageBase ∧ discriminated-union ∨ unknown`)
 * unfortunately loses the discriminator narrowing through `z.union` with a
 * catch-all. Casting per-branch to a local view type keeps types tight
 * without rewriting the whole schema tree.
 */
function deriveContent(msg: WhatsappMessage): DerivedContent | null {
  // Prefer the record view — runtime shape is always a dict anyway.
  const m = msg as unknown as Record<string, unknown> & { type: string };
  const mediaRef = (key: string) => m[key] as
    | {
        id: string;
        mime_type?: string;
        caption?: string;
        filename?: string;
      }
    | undefined;

  switch (msg.type) {
    case 'text': {
      const body = (m.text as { body?: string } | undefined)?.body ?? '';
      return { contentType: 'text', text: body };
    }
    case 'image': {
      const ref = mediaRef('image');
      if (!ref) return null;
      return {
        contentType: 'image',
        text: ref.caption ?? null,
        mediaId: ref.id,
        mediaMimeHint: ref.mime_type,
      };
    }
    case 'audio': {
      const ref = mediaRef('audio');
      if (!ref) return null;
      return {
        contentType: 'audio',
        text: null,
        mediaId: ref.id,
        mediaMimeHint: ref.mime_type,
      };
    }
    case 'video': {
      const ref = mediaRef('video');
      if (!ref) return null;
      return {
        contentType: 'video',
        text: ref.caption ?? null,
        mediaId: ref.id,
        mediaMimeHint: ref.mime_type,
      };
    }
    case 'document': {
      const ref = mediaRef('document');
      if (!ref) return null;
      return {
        contentType: 'file',
        text: ref.caption ?? ref.filename ?? null,
        mediaId: ref.id,
        mediaMimeHint: ref.mime_type,
      };
    }
    case 'sticker': {
      const ref = mediaRef('sticker');
      if (!ref) return null;
      return {
        contentType: 'image',
        text: null,
        mediaId: ref.id,
        mediaMimeHint: ref.mime_type ?? 'image/webp',
      };
    }
    case 'location': {
      const loc = m.location as
        | { latitude: number; longitude: number; name?: string; address?: string }
        | undefined;
      if (!loc) return null;
      const parts = [
        loc.name ? `📍 ${loc.name}` : '📍',
        loc.address,
        `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`,
      ].filter(Boolean);
      return { contentType: 'text', text: parts.join('\n') };
    }
    case 'button': {
      const b = m.button as { text?: string; payload?: string } | undefined;
      return { contentType: 'text', text: b?.text ?? b?.payload ?? '' };
    }
    case 'interactive':
      return { contentType: 'text', text: JSON.stringify(m.interactive ?? {}) };
    case 'contacts':
      return { contentType: 'text', text: JSON.stringify(m.contacts ?? []) };
    default:
      return null;
  }
}
