import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { InteractionIngestedEvent } from '@nexus/shared';
import {
  and,
  contactIdentifiers,
  contacts,
  eq,
  ilike,
  insertAttachment,
  interactions as interactionsTable,
  sessions as sessionsTable,
  upsertInteraction,
} from '@nexus/db';
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
  filename: string | null;
  meta: PhoneUploadMeta;
}): Promise<PhoneIngestResult> {
  const { audio, mimeType, filename, meta } = args;
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

  // Parse the contact name out of the filename BEFORE creating the
  // interaction so we can stamp it onto rawPayload for future debugging.
  const parsedCounterparty = parseCounterpartyFromFilename(filename);

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
      filename: filename ?? null,
      parsedCounterparty: parsedCounterparty ?? null,
    },
  });

  const attachment = await insertAttachment(db, {
    interactionId: interaction.id,
    r2Key: storageKey, // legacy column name; now stores the Supabase Storage key
    mimeType,
    sizeBytes: audio.byteLength,
    checksum: checksumHex,
  });

  // Resolve the counterparty contact from the filename ("Call recording
  // <Display Name>_<digits>...") and pin this interaction to a fresh
  // session under that contact. Without this every recording buckets
  // into a single catch-all "Phone Calls" contact, which makes Injaz
  // client/project mapping useless and merges unrelated conversations
  // into one approval queue.
  if (inserted) {
    await attachPhoneCallToContactSession(db, {
      interactionId: interaction.id,
      occurredAt,
      counterparty: parsedCounterparty ?? meta.counterparty ?? null,
    });
  }

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

/**
 * Extract the counterparty's display name (or phone number) from the
 * Android call recording filename.
 *
 * The Android-14+ native call recorder names files:
 *   Call recording <Counterparty>_<digits>.<ext>
 *
 * `<Counterparty>` is the address-book display name when the caller is
 * saved on the device, otherwise the dialed/received phone number.
 * `<digits>` is a yyyyMMdd_HHmmss style timestamp (or shorter sequence
 * id on some OEM ROMs). Strip both ends and what's left is the contact.
 *
 * Examples (after lowercase + diacritics intact for Arabic):
 *   "Call recording John Doe_250428_1234.m4a"     → "John Doe"
 *   "Call recording إسلام يوسري_20260428.m4a"     → "إسلام يوسري"
 *   "Call recording +20123456789_250428.m4a"      → "+20123456789"
 *   "Call recording Mom 🥰_250428_1234.m4a"        → "Mom 🥰"
 *   "20260428_134523_audio.m4a" (other recorder)   → null
 *   "" / null                                       → null
 *
 * Returns null when the filename doesn't match the "Call recording …"
 * pattern — caller falls back to the catch-all contact.
 */
export function parseCounterpartyFromFilename(
  filename: string | null,
): string | null {
  if (!filename) return null;
  // Strip directory path and extension first.
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '');

  // The "Call recording " prefix is locale-dependent. English ROMs use
  // "Call recording ", Arabic ROMs use "تسجيل المكالمة "/"تسجيل مكالمة ".
  // Match case-insensitively and tolerate surrounding whitespace.
  const m = base.match(
    /^(?:call recording|تسجيل (?:ال)?مكالم[ةه])\s+(.+?)$/i,
  );
  if (!m || !m[1]) return null;

  // Strip the trailing `_<digits>` block(s). Recorders append one or
  // two underscore-prefixed digit groups (`_yyyyMMdd_HHmmss`, sometimes
  // just `_seqno`). Iterate so both groups come off.
  let name = m[1];
  while (/_\d+$/.test(name)) {
    name = name.replace(/_\d+$/, '');
  }
  name = name.trim();
  return name.length > 0 ? name : null;
}

/**
 * Resolve a contact from the parsed counterparty (display name or
 * phone number). Looks up existing contacts by:
 *   1. phone identifier match (when counterparty looks like E.164),
 *   2. case-insensitive displayName match (otherwise),
 *   3. lazy-create a new contact stamped with the counterparty.
 *
 * Falls back to the catch-all "Phone Calls" contact when no
 * counterparty was extractable (filename didn't match the pattern).
 */
async function resolveContactForCall(
  db: ReturnType<typeof getDb>,
  counterparty: string | null,
): Promise<{ id: string; created: boolean }> {
  if (!counterparty) {
    return ensureCatchAllContact(db);
  }

  // Phone-number-shaped string → match by identifier.
  const looksLikePhone = /^\+?[0-9][0-9\s\-()]{6,20}$/.test(counterparty);
  if (looksLikePhone) {
    const normalized = counterparty.replace(/[\s\-()]/g, '');
    const [hit] = await db
      .select({ contactId: contactIdentifiers.contactId })
      .from(contactIdentifiers)
      .where(
        and(
          eq(contactIdentifiers.kind, 'phone'),
          eq(contactIdentifiers.value, normalized),
        ),
      )
      .limit(1);
    if (hit) return { id: hit.contactId, created: false };

    // Create new contact + identifier pair.
    const [contact] = await db
      .insert(contacts)
      .values({
        displayName: counterparty,
        notes: 'Auto-created from a phone-call recording filename.',
      })
      .returning({ id: contacts.id });
    if (!contact) throw new Error('failed to create contact for phone number');
    await db.insert(contactIdentifiers).values({
      contactId: contact.id,
      kind: 'phone',
      value: normalized,
      verified: false,
      source: 'phone-recording-filename',
    });
    return { id: contact.id, created: true };
  }

  // Display-name string → case-insensitive match. Uses ilike with the
  // value escaped so any LIKE wildcards in the contact name are literal.
  const escaped = counterparty.replace(/[\\%_]/g, (c) => '\\' + c);
  const [hit] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(ilike(contacts.displayName, escaped))
    .limit(1);
  if (hit) return { id: hit.id, created: false };

  const [contact] = await db
    .insert(contacts)
    .values({
      displayName: counterparty,
      notes: 'Auto-created from a phone-call recording filename.',
    })
    .returning({ id: contacts.id });
  if (!contact) throw new Error('failed to create contact for display name');
  return { id: contact.id, created: true };
}

async function ensureCatchAllContact(
  db: ReturnType<typeof getDb>,
): Promise<{ id: string; created: boolean }> {
  const PHONE_NAME = 'Phone Calls';
  let [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.displayName, PHONE_NAME))
    .limit(1);
  if (row) return { id: row.id, created: false };
  const created = await db
    .insert(contacts)
    .values({
      displayName: PHONE_NAME,
      notes: 'Catch-all bucket for phone recordings whose filename did not match the expected pattern.',
    })
    .returning({ id: contacts.id });
  row = created[0];
  if (!row) throw new Error('failed to create Phone Calls catch-all contact');
  return { id: row.id, created: true };
}

/**
 * Resolve the counterparty contact and open a fresh session for this
 * recording. Backdates lastActivityAt by 10 min so the next auto-reason
 * tick (default 3 min cooldown) picks the session up immediately. Same
 * pattern as the meeting endpoint — each call is its own conversation.
 */
async function attachPhoneCallToContactSession(
  db: ReturnType<typeof getDb>,
  args: { interactionId: string; occurredAt: Date; counterparty: string | null },
): Promise<void> {
  const { interactionId, occurredAt, counterparty } = args;

  const { id: contactId, created } = await resolveContactForCall(db, counterparty);
  if (created && counterparty) {
    log.info('phone.contact.auto_created', {
      interactionId,
      contactId,
      counterparty,
    });
  }

  const backdated = new Date(occurredAt.getTime() - 10 * 60 * 1000);
  const [session] = await db
    .insert(sessionsTable)
    .values({
      contactId,
      state: 'open',
      openedAt: occurredAt,
      lastActivityAt: backdated,
    })
    .returning({ id: sessionsTable.id });
  if (!session) throw new Error('failed to open phone session');

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
