import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { InteractionIngestedEvent } from '@nexus/shared';
import { insertAttachment, upsertInteraction } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { getDb } from '../../db';
import { log } from '../../logger';

export interface MeetingIngestResult {
  interactionId: string;
  attachmentId: string;
  inserted: boolean;
  storageKey: string;
  sizeBytes: number;
  checksumHex: string;
  alreadyExisted: boolean;
}

export interface MeetingMeta {
  /** ISO-8601 when recording started on the client */
  startedAt: string;
  /** ISO-8601 when recording ended on the client */
  endedAt: string;
  /** Free-form device label, e.g. "MacBook Pro" */
  device: string;
  /** e.g. "macos-recorder" */
  source: string;
  /** Suggested filename (used only as a hint in the storage key) */
  filename: string;
}

/**
 * Persist a meeting recording end-to-end.
 *
 * 1. Upload the audio bytes to Supabase Storage under a content-
 *    addressed key (SHA-256 of bytes) so retries are idempotent.
 * 2. Upsert an `interactions` row with `channel='teams'`, `content_type='meeting'`.
 *    We reuse the `teams` channel until we add a dedicated `meeting`
 *    channel migration — it keeps the DB enum stable for now.
 * 3. Attach the storage key.
 * 4. Emit `nexus/interaction.ingested` so the transcription worker
 *    kicks in.
 */
export async function ingestMeetingRecording(args: {
  audio: Uint8Array;
  mimeType: string;
  meta: MeetingMeta;
}): Promise<MeetingIngestResult> {
  const { audio, mimeType, meta } = args;
  const checksumHex = createHash('sha256').update(audio).digest('hex');
  const occurredAt = new Date(meta.startedAt);
  const endedAt = new Date(meta.endedAt);
  const durationSec = Math.max(
    0,
    Math.round((endedAt.getTime() - occurredAt.getTime()) / 1000),
  );

  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'nexus-attachments';
  const storageKey = buildStorageKey(occurredAt, checksumHex, mimeType);
  const uploaded = await uploadToStorage({
    bucket,
    key: storageKey,
    bytes: audio,
    mimeType,
  });

  const db = getDb();

  // Dedup by checksum — re-uploads of the same file from the client
  // should land on the same interaction row.
  const callId = `meeting:${checksumHex.slice(0, 16)}`;

  const { interaction, inserted } = await upsertInteraction(db, {
    channel: 'teams',
    direction: 'internal',
    contentType: 'meeting',
    text: null,
    sourceMessageId: callId,
    occurredAt,
    rawPayload: {
      source: meta.source,
      device: meta.device,
      filename: meta.filename,
      durationSec,
      storageKey,
      checksum: checksumHex,
      endedAt: meta.endedAt,
    },
  });

  const attachment = await insertAttachment(db, {
    interactionId: interaction.id,
    r2Key: storageKey, // legacy column name; now stores Supabase Storage key
    mimeType,
    sizeBytes: audio.byteLength,
    checksum: checksumHex,
  });

  if (inserted) {
    const event: InteractionIngestedEvent = {
      name: 'nexus/interaction.ingested',
      data: {
        interactionId: interaction.id,
        channel: 'teams',
        sourceMessageId: callId,
        occurredAt: occurredAt.toISOString(),
      },
    };
    try {
      await inngest.send(event);
    } catch (err) {
      log.warn('meeting.inngest.emit_failed', {
        interactionId: interaction.id,
        err: (err as Error).message,
      });
    }
  }

  return {
    interactionId: interaction.id,
    attachmentId: attachment.id,
    inserted,
    storageKey,
    sizeBytes: audio.byteLength,
    checksumHex,
    alreadyExisted: uploaded.alreadyExisted,
  };
}

function buildStorageKey(
  occurredAt: Date,
  checksumHex: string,
  mimeType: string,
): string {
  const ext = mimeType.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') || 'm4a';
  const yyyy = occurredAt.getUTCFullYear();
  const mm = String(occurredAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(occurredAt.getUTCDate()).padStart(2, '0');
  return `meeting/${yyyy}/${mm}/${dd}/${checksumHex}.${ext}`;
}

// --- Supabase Storage helper (service-role scoped) ---

let _client: SupabaseClient | null = null;
function storageClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

async function uploadToStorage(args: {
  bucket: string;
  key: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<{ alreadyExisted: boolean }> {
  const c = storageClient();
  const { error } = await c.storage.from(args.bucket).upload(args.key, args.bytes, {
    contentType: args.mimeType,
    upsert: false,
  });
  if (!error) return { alreadyExisted: false };
  if (error.message.toLowerCase().includes('already exists')) {
    return { alreadyExisted: true };
  }
  throw new Error(`storage upload failed: ${error.message}`);
}
