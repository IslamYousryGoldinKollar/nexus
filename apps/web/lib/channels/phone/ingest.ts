import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { InteractionIngestedEvent } from '@nexus/shared';
import { insertAttachment, upsertInteraction } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';
import { getDb } from '../../db';
import { log } from '../../logger';
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
 * Storage backend is Supabase Storage — same as meeting/whatsapp/etc.
 * The Phase 1 implementation used Cloudflare R2, but R2 credentials
 * were never set on Vercel; the rest of the project consolidated on
 * Supabase Storage (cheaper, single-vendor, signed URLs work via the
 * existing helpers). Migrating phone here unblocks the Android upload
 * pipeline that's been failing with "R2 credentials not configured"
 * since Phase 1.
 *
 * 1. SHA-256 the bytes and use the hex as the storage key suffix —
 *    dedupes retries automatically.
 * 2. Upload to Supabase Storage. Returns alreadyExisted=true on
 *    duplicate, which we treat as success.
 * 3. Upsert `interactions` row (channel=phone, content_type=call).
 * 4. Attach the storage key to the interaction.
 * 5. Emit `nexus/interaction.ingested` so the transcription cron picks
 *    it up.
 */
export async function ingestPhoneCall(args: {
  audio: Uint8Array;
  mimeType: string;
  meta: PhoneUploadMeta;
}): Promise<PhoneIngestResult> {
  const { audio, mimeType, meta } = args;
  const db = getDb();

  const occurredAt = new Date(meta.startedAt);
  const checksumHex = createHash('sha256').update(audio).digest('hex');
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'nexus-attachments';
  const storageKey = buildStorageKey(occurredAt, checksumHex, mimeType);

  const uploaded = await uploadToStorage({
    bucket,
    key: storageKey,
    bytes: audio,
    mimeType,
  });

  const { interaction, inserted } = await upsertInteraction(db, {
    channel: 'phone',
    direction: meta.direction,
    contentType: 'call',
    text: null,
    sourceMessageId: meta.callId,
    occurredAt,
    rawPayload: {
      counterparty: meta.counterparty ?? null,
      durationSec: meta.durationSec,
      recorder: meta.recorder ?? null,
      storageKey,
      checksum: checksumHex,
    },
  });

  const attachment = await insertAttachment(db, {
    interactionId: interaction.id,
    r2Key: storageKey, // legacy column name; now stores the Supabase Storage key
    mimeType,
    sizeBytes: audio.byteLength,
    checksum: checksumHex,
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
    r2Key: storageKey,
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
  return `phone/${yyyy}/${mm}/${dd}/${checksumHex}.${ext}`;
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
