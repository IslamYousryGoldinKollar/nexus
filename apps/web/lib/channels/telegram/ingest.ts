import type { ContentType, InteractionIngestedEvent } from '@nexus/shared';
import { insertAttachment, upsertInteraction } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { getDb } from '../../db';
import { log } from '../../logger';
import { uploadToR2 } from '../../r2';
import { downloadFile, TelegramMediaError } from './media';
import type { TelegramMessage, TelegramUpdate } from './schema';

export interface TelegramIngestOutcome {
  sourceMessageId: string;
  type: string;
  interactionId: string;
  inserted: boolean;
  attachmentId?: string;
  skipped?:
    | 'edited_message'
    | 'callback_query'
    | 'no_content'
    | 'unsupported_update'
    | 'media_download_failed';
}

/**
 * Ingest a single Telegram Update.
 *
 * Phase 1 scope: messages + channel posts. Edited messages, callback
 * queries (approvals), etc. are skipped — they belong to Phase 9.
 */
export async function ingestTelegramUpdate(
  update: TelegramUpdate,
): Promise<TelegramIngestOutcome[]> {
  // Explicit skip-lists first so they never try to persist.
  if (update.callback_query) {
    return [
      {
        sourceMessageId: String(update.callback_query.id),
        type: 'callback_query',
        interactionId: '',
        inserted: false,
        skipped: 'callback_query',
      },
    ];
  }
  if (update.edited_message || update.edited_channel_post) {
    const edited = update.edited_message ?? update.edited_channel_post!;
    return [
      {
        sourceMessageId: buildSourceId(edited),
        type: 'edited_message',
        interactionId: '',
        inserted: false,
        skipped: 'edited_message',
      },
    ];
  }

  const msg = update.message ?? update.channel_post;
  if (!msg) {
    return [
      {
        sourceMessageId: String(update.update_id),
        type: 'unknown',
        interactionId: '',
        inserted: false,
        skipped: 'unsupported_update',
      },
    ];
  }

  const outcome = await ingestOneTelegramMessage(msg);
  return [outcome];
}

async function ingestOneTelegramMessage(
  msg: TelegramMessage,
): Promise<TelegramIngestOutcome> {
  const db = getDb();
  const occurredAt = new Date(msg.date * 1000);
  const sourceMessageId = buildSourceId(msg);
  const derived = deriveTelegramContent(msg);

  if (!derived) {
    return {
      sourceMessageId,
      type: 'empty',
      interactionId: '',
      inserted: false,
      skipped: 'no_content',
    };
  }

  const { interaction, inserted } = await upsertInteraction(db, {
    channel: 'telegram',
    direction: 'inbound',
    contentType: derived.contentType,
    text: derived.text,
    sourceMessageId,
    occurredAt,
    rawPayload: msg as unknown as Record<string, unknown>,
  });

  const outcome: TelegramIngestOutcome = {
    sourceMessageId,
    type: derived.debugType,
    interactionId: interaction.id,
    inserted,
  };

  if (derived.fileId && inserted) {
    try {
      const file = await downloadFile(derived.fileId, derived.mimeHint);
      const mime = file.mimeType ?? derived.mimeHint ?? 'application/octet-stream';
      const uploaded = await uploadToR2({
        channel: 'telegram',
        bytes: file.bytes,
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
      log.info('telegram.media.uploaded', {
        fileId: derived.fileId,
        r2Key: uploaded.key,
        sizeBytes: uploaded.sizeBytes,
        alreadyExisted: uploaded.alreadyExisted,
      });
    } catch (err) {
      outcome.skipped = 'media_download_failed';
      const fields: Record<string, unknown> = {
        fileId: derived.fileId,
        err: (err as Error).message,
      };
      if (err instanceof TelegramMediaError && typeof err.status === 'number') {
        fields.status = err.status;
      }
      log.warn('telegram.media.download_failed', fields);
    }
  }

  if (inserted) {
    const event: InteractionIngestedEvent = {
      name: 'nexus/interaction.ingested',
      data: {
        interactionId: interaction.id,
        channel: 'telegram',
        sourceMessageId,
        occurredAt: occurredAt.toISOString(),
      },
    };
    try {
      await inngest.send(event);
    } catch (err) {
      log.warn('telegram.inngest.emit_failed', {
        interactionId: interaction.id,
        err: (err as Error).message,
      });
    }
  }

  return outcome;
}

/**
 * Telegram messages are globally unique per `(chat_id, message_id)`.
 * We store `chat_id:message_id` as the source id — stable across retries.
 */
function buildSourceId(msg: TelegramMessage): string {
  return `${msg.chat.id}:${msg.message_id}`;
}

interface TelegramDerived {
  contentType: ContentType;
  text: string | null;
  fileId?: string;
  mimeHint?: string;
  debugType: string;
}

function deriveTelegramContent(msg: TelegramMessage): TelegramDerived | null {
  if (msg.voice) {
    return {
      contentType: 'audio',
      text: msg.caption ?? null,
      fileId: msg.voice.file_id,
      mimeHint: msg.voice.mime_type ?? 'audio/ogg',
      debugType: 'voice',
    };
  }
  if (msg.audio) {
    const title = [msg.audio.performer, msg.audio.title].filter(Boolean).join(' — ');
    return {
      contentType: 'audio',
      text: msg.caption ?? (title || null),
      fileId: msg.audio.file_id,
      mimeHint: msg.audio.mime_type ?? 'audio/mpeg',
      debugType: 'audio',
    };
  }
  if (msg.video || msg.video_note) {
    const v = (msg.video ?? msg.video_note)!;
    return {
      contentType: 'video',
      text: msg.caption ?? null,
      fileId: v.file_id,
      mimeHint: v.mime_type ?? 'video/mp4',
      debugType: msg.video ? 'video' : 'video_note',
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    // Telegram sends multiple resolutions; pick the largest.
    const largest = msg.photo.reduce((a, b) =>
      (a.file_size ?? a.width * a.height) > (b.file_size ?? b.width * b.height) ? a : b,
    );
    return {
      contentType: 'image',
      text: msg.caption ?? null,
      fileId: largest.file_id,
      mimeHint: 'image/jpeg',
      debugType: 'photo',
    };
  }
  if (msg.document) {
    return {
      contentType: 'file',
      text: msg.caption ?? msg.document.file_name ?? null,
      fileId: msg.document.file_id,
      mimeHint: msg.document.mime_type ?? 'application/octet-stream',
      debugType: 'document',
    };
  }
  if (msg.sticker) {
    return {
      contentType: 'image',
      text: msg.sticker.emoji ?? null,
      fileId: msg.sticker.file_id,
      mimeHint: msg.sticker.mime_type ?? 'image/webp',
      debugType: 'sticker',
    };
  }
  if (msg.location) {
    const { latitude, longitude } = msg.location;
    return {
      contentType: 'text',
      text: `📍 ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      debugType: 'location',
    };
  }
  if (msg.contact) {
    const name = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ');
    return {
      contentType: 'text',
      text: `📇 ${name} · ${msg.contact.phone_number}`,
      debugType: 'contact',
    };
  }
  if (msg.text) {
    return {
      contentType: 'text',
      text: msg.text,
      debugType: 'text',
    };
  }
  return null;
}
