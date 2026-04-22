import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { env } from './env.js';
import { log } from './logger.js';

/**
 * Thin Supabase Storage wrapper used by the bridge for two purposes:
 *
 *   1. Uploading inbound WhatsApp media (images, audio, docs) so the
 *      Nexus web app can reference them by stable key instead of a
 *      short-lived Baileys URL.
 *
 *   2. Persisting Baileys multi-file auth state so a pod restart doesn't
 *      require re-pairing. Auth files are small JSON blobs — plenty fast
 *      to round-trip via Storage on each reconnect.
 *
 * Keys are namespaced:
 *   - media:   baileys/{yyyy}/{mm}/{dd}/{sha256}.{ext}
 *   - auth:    baileys-auth/{file}                  (flat, one folder)
 */

let _client: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (_client) return _client;
  _client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });
  return _client;
}

export interface UploadedMedia {
  key: string;
  sizeBytes: number;
  checksumHex: string;
  mimeType: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mediaKeyFor(occurredAt: Date, checksum: string, mime: string): string {
  const ext = mime.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const yyyy = occurredAt.getUTCFullYear();
  const mm = String(occurredAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(occurredAt.getUTCDate()).padStart(2, '0');
  return `baileys/${yyyy}/${mm}/${dd}/${checksum}.${ext}`;
}

/**
 * Upload is idempotent: if the bucket already has an object at the derived
 * key (i.e. same content), we return its metadata without re-uploading.
 * Baileys occasionally re-emits the same message on reconnect.
 */
export async function uploadMedia(params: {
  bytes: Uint8Array;
  mimeType: string;
  occurredAt: Date;
}): Promise<UploadedMedia> {
  const checksum = sha256Hex(params.bytes);
  const key = mediaKeyFor(params.occurredAt, checksum, params.mimeType);

  // Try a HEAD-like list to short-circuit if already uploaded.
  const { data: existing } = await client()
    .storage.from(env.storageBucket)
    .list(key.split('/').slice(0, -1).join('/'), {
      limit: 1,
      search: key.split('/').pop(),
    });
  if (existing && existing.length > 0) {
    return {
      key,
      sizeBytes: params.bytes.byteLength,
      checksumHex: checksum,
      mimeType: params.mimeType,
    };
  }

  const { error } = await client()
    .storage.from(env.storageBucket)
    .upload(key, params.bytes, {
      contentType: params.mimeType,
      upsert: false,
    });

  if (error && !error.message.toLowerCase().includes('already exists')) {
    throw new Error(`storage upload failed: ${error.message}`);
  }

  log.debug({ key, size: params.bytes.byteLength, mime: params.mimeType }, 'media.uploaded');
  return {
    key,
    sizeBytes: params.bytes.byteLength,
    checksumHex: checksum,
    mimeType: params.mimeType,
  };
}

/**
 * Auth-state sync. We keep a hot copy on disk so Baileys' file I/O is
 * fast, and we push each file to Storage on change so a cold pod restart
 * can hydrate before opening the WebSocket.
 */
const AUTH_PREFIX = 'baileys-auth';

export async function readAuthFile(name: string): Promise<Uint8Array | null> {
  const { data, error } = await client()
    .storage.from(env.storageBucket)
    .download(`${AUTH_PREFIX}/${name}`);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  return new Uint8Array(buf);
}

export async function writeAuthFile(name: string, bytes: Uint8Array): Promise<void> {
  const { error } = await client()
    .storage.from(env.storageBucket)
    .upload(`${AUTH_PREFIX}/${name}`, bytes, {
      contentType: 'application/json',
      upsert: true,
    });
  if (error) throw new Error(`auth upload failed: ${name}: ${error.message}`);
}

export async function listAuthFiles(): Promise<string[]> {
  const { data, error } = await client()
    .storage.from(env.storageBucket)
    .list(AUTH_PREFIX, { limit: 1000 });
  if (error) throw new Error(`auth list failed: ${error.message}`);
  return (data ?? []).map((f) => f.name);
}

/**
 * Nuke all remote auth files. Called on WA "logged out" so the next
 * boot pairs cleanly instead of re-hydrating broken creds and
 * restart-looping until Fly stops the machine.
 */
export async function wipeAuthFiles(): Promise<number> {
  const names = await listAuthFiles().catch(() => [] as string[]);
  if (names.length === 0) return 0;
  const paths = names.map((n) => `${AUTH_PREFIX}/${n}`);
  const { error } = await client()
    .storage.from(env.storageBucket)
    .remove(paths);
  if (error) throw new Error(`auth wipe failed: ${error.message}`);
  return paths.length;
}
