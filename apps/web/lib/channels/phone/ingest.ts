import type { InteractionIngestedEvent } from '@nexus/shared';
import { insertAttachment, upsertInteraction } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { getDb } from '../../db';
import { log } from '../../logger';
import { uploadToR2 } from '../../r2';
import type { PhoneUploadMeta } from './schema';

export interface PhoneIngestResult {
  interactionId: string;
  attachmentId: string;
  inserted: boolean;
  r2Key: string;
  sizeBytes: number;
  checksumHex: string;
  alreadyExisted: boolean;
}

/**
 * Persist a phone call recording.
 *
 * 1. Upload audio bytes to R2 (content-addressed; dedupes across retries).
 * 2. Upsert `interactions` row with channel=phone, content_type=call.
 * 3. Attach the R2 object to the interaction.
 * 4. Emit `nexus/interaction.ingested` so Phase 2+ can transcribe + reason.
 */
export async function ingestPhoneCall(args: {
  audio: Uint8Array;
  mimeType: string;
  meta: PhoneUploadMeta;
}): Promise<PhoneIngestResult> {
  const { audio, mimeType, meta } = args;
  const db = getDb();

  const occurredAt = new Date(meta.startedAt);
  const uploaded = await uploadToR2({
    channel: 'phone',
    bytes: audio,
    mimeType,
    occurredAt,
  });

  const { interaction, inserted } = await upsertInteraction(db, {
    channel: 'phone',
    direction: meta.direction,
    contentType: 'call',
    text: null,
    sourceMessageId: meta.callId,
    occurredAt,
    rawPayload: {
      counterparty: meta.counterparty,
      durationSec: meta.durationSec,
      recorder: meta.recorder ?? null,
      r2Key: uploaded.key,
      checksum: uploaded.checksumHex,
    },
  });

  const attachment = await insertAttachment(db, {
    interactionId: interaction.id,
    r2Key: uploaded.key,
    mimeType: uploaded.mimeType,
    sizeBytes: uploaded.sizeBytes,
    checksum: uploaded.checksumHex,
  });

  if (inserted) {
    const event: InteractionIngestedEvent = {
      name: 'nexus/interaction.ingested',
      data: {
        interactionId: interaction.id,
        channel: 'phone',
        sourceMessageId: meta.callId,
        occurredAt: occurredAt.toISOString(),
      },
    };
    try {
      await inngest.send(event);
    } catch (err) {
      log.warn('phone.inngest.emit_failed', {
        interactionId: interaction.id,
        err: (err as Error).message,
      });
    }
  }

  return {
    interactionId: interaction.id,
    attachmentId: attachment.id,
    inserted,
    r2Key: uploaded.key,
    sizeBytes: uploaded.sizeBytes,
    checksumHex: uploaded.checksumHex,
    alreadyExisted: uploaded.alreadyExisted,
  };
}
