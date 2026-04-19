import { insertAttachment, upsertInteraction } from '@nexus/db';
import type { Channel } from '@nexus/shared';
import { inngest } from '@nexus/inngest-fns';
import { getDb } from '../../db';
import { log } from '../../logger';
import { uploadToR2 } from '../../r2';
import type { TeamsIngestPayload } from './schema';

/**
 * Persist a single Teams message + (optionally) download its attachment.
 *
 * Designed to mirror the WhatsApp/Telegram ingestion contract:
 *   1. upsertInteraction (idempotent on UNIQUE(channel, source_message_id))
 *   2. download attachment → R2 (content-addressed)
 *   3. insertAttachment row
 *   4. emit nexus/interaction.ingested
 */
export async function ingestTeamsMessage(payload: TeamsIngestPayload): Promise<{
  interactionId: string;
  inserted: boolean;
  attachmentId?: string;
}> {
  const db = getDb();
  const occurredAt = new Date(payload.occurredAt);
  const channel: Channel = 'teams';

  const { interaction, inserted } = await upsertInteraction(db, {
    channel,
    sourceMessageId: payload.messageId,
    direction: payload.direction,
    contentType: payload.attachmentUrl ? 'audio' : 'text',
    text: payload.text ?? null,
    occurredAt,
    rawPayload: {
      from: { id: payload.fromUserId, name: payload.fromName },
      conversationId: payload.conversationId,
      ...(payload.attachmentUrl ? { attachment: payload.attachmentUrl } : {}),
    } as Record<string, unknown>,
  });

  let attachmentId: string | undefined;
  if (payload.attachmentUrl && payload.attachmentMime) {
    try {
      const downloadRes = await fetch(payload.attachmentUrl, { cache: 'no-store' });
      if (!downloadRes.ok) throw new Error(`download ${downloadRes.status}`);
      const bytes = new Uint8Array(await downloadRes.arrayBuffer());
      const upload = await uploadToR2({
        channel: 'teams',
        bytes,
        mimeType: payload.attachmentMime,
        occurredAt,
      });
      const att = await insertAttachment(db, {
        interactionId: interaction.id,
        mimeType: payload.attachmentMime,
        sizeBytes: bytes.length,
        r2Key: upload.key,
        checksum: upload.checksumHex,
      });
      attachmentId = att.id;
    } catch (err) {
      log.warn('teams.attachment.download_failed', {
        url: payload.attachmentUrl,
        err: (err as Error).message,
      });
    }
  }

  if (inserted) {
    await inngest.send({
      name: 'nexus/interaction.ingested',
      data: {
        interactionId: interaction.id,
        channel,
        sourceMessageId: payload.messageId,
        occurredAt: occurredAt.toISOString(),
      },
    });
  }

  return { interactionId: interaction.id, inserted, attachmentId };
}
