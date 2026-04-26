import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { InteractionIngestedEvent } from '@nexus/shared';
import {
  contacts,
  eq,
  insertAttachment,
  interactions as interactionsTable,
  sessions as sessionsTable,
  sql,
  upsertInteraction,
} from '@nexus/db';
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

  // Meetings don't have a counterparty identifier (no phone/email
  // in the upload payload), so the regular process-pending cron skips
  // them and they end up orphaned with session_id = NULL. Pin every
  // meeting to a synthetic "Meetings" contact and open a fresh session
  // per recording. lastActivityAt is backdated past the cooldown so
  // the next auto-reason tick picks it up immediately.
  if (inserted) {
    await attachMeetingToSession(db, interaction.id, occurredAt, endedAt);
  }

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

/**
 * Resolve (or lazily create) the catch-all "Meetings" contact and
 * open a fresh session for this meeting recording. We deliberately
 * don't reuse the contact's previous session — each meeting is its
 * own conversation and should produce its own approval card.
 */
async function attachMeetingToSession(
  db: ReturnType<typeof getDb>,
  interactionId: string,
  occurredAt: Date,
  endedAt: Date,
): Promise<void> {
  const MEETINGS_NAME = 'Meetings';

  let [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.displayName, MEETINGS_NAME))
    .limit(1);

  if (!row) {
    const created = await db
      .insert(contacts)
      .values({
        displayName: MEETINGS_NAME,
        notes: 'Auto-created bucket for browser-extension meeting recordings.',
      })
      .returning({ id: contacts.id });
    row = created[0];
    if (!row) throw new Error('failed to create Meetings contact');
  }

  // Backdate lastActivityAt by 10 minutes so the next auto-reason tick
  // (which only picks up sessions past SESSION_COOLDOWN_MIN, default 5)
  // grabs this session right away instead of waiting for new activity.
  const backdated = new Date(endedAt.getTime() - 10 * 60 * 1000);
  const [session] = await db
    .insert(sessionsTable)
    .values({
      contactId: row.id,
      state: 'open',
      openedAt: occurredAt,
      lastActivityAt: backdated,
    })
    .returning({ id: sessionsTable.id });
  if (!session) throw new Error('failed to open meeting session');

  await db
    .update(interactionsTable)
    .set({ sessionId: session.id })
    .where(eq(interactionsTable.id, interactionId));
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
