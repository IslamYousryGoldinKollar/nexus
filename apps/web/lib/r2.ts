import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { serverEnv } from './env';

/**
 * Cloudflare R2 client (S3-compatible).
 *
 * R2 API endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
 * Region is a fixed "auto" per Cloudflare's docs.
 *
 * Uploaded objects live under a namespaced key:
 *   `<channel>/<yyyy>/<mm>/<dd>/<sha256-hex><ext>`
 *
 * Deduplication is implicit — two identical bodies produce the same key
 * because the sha256 of the body is in the path. Repeat uploads are a
 * no-op (same bytes → same `ETag`).
 */

let _client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (_client) return _client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = serverEnv;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 credentials not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

function getBucket(): string {
  return serverEnv.R2_BUCKET;
}

/**
 * Compute the hex SHA-256 of a byte sequence.
 * Used to build content-addressed R2 keys and deduplicate attachments.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as ArrayBuffer,
  );
  const out = new Uint8Array(buf);
  let hex = '';
  for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Build a stable, content-addressed R2 key for an attachment.
 *
 * Path layout makes it easy to:
 *   · eyeball recent activity in the R2 dashboard (date-bucketed)
 *   · lifecycle-rule old blobs by prefix (e.g., `phone/2026/01/*` → archive)
 *   · debug dedupe issues (checksum is in the path)
 */
export function buildAttachmentKey(args: {
  channel: string;
  checksumHex: string;
  mimeType: string;
  occurredAt?: Date;
}): string {
  const date = args.occurredAt ?? new Date();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const ext = mimeToExt(args.mimeType);
  return `${args.channel}/${yyyy}/${mm}/${dd}/${args.checksumHex}${ext}`;
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.startsWith('image/jpeg')) return '.jpg';
  if (m.startsWith('image/png')) return '.png';
  if (m.startsWith('image/webp')) return '.webp';
  if (m.startsWith('image/gif')) return '.gif';
  if (m.startsWith('audio/ogg')) return '.ogg';
  if (m.startsWith('audio/mpeg')) return '.mp3';
  if (m.startsWith('audio/mp4') || m.startsWith('audio/aac')) return '.m4a';
  if (m.startsWith('audio/wav') || m.startsWith('audio/x-wav')) return '.wav';
  if (m.startsWith('video/mp4')) return '.mp4';
  if (m.startsWith('application/pdf')) return '.pdf';
  if (m.startsWith('application/zip')) return '.zip';
  return '';
}

export interface UploadResult {
  key: string;
  checksumHex: string;
  sizeBytes: number;
  mimeType: string;
  alreadyExisted: boolean;
}

/**
 * Put a blob in R2 (if not already present).
 *
 * @returns metadata needed to insert an `attachments` row.
 */
export async function uploadToR2(args: {
  channel: string;
  bytes: Uint8Array;
  mimeType: string;
  occurredAt?: Date;
  /** Optional cache-control for the object, e.g. `public, max-age=31536000, immutable`. */
  cacheControl?: string;
}): Promise<UploadResult> {
  const { channel, bytes, mimeType, occurredAt, cacheControl } = args;
  const checksumHex = await sha256Hex(bytes);
  const key = buildAttachmentKey({ channel, checksumHex, mimeType, occurredAt });
  const bucket = getBucket();
  const client = getR2Client();

  // HEAD to dedupe — saves bandwidth for retries and repeat audio.
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      key,
      checksumHex,
      sizeBytes: Number(head.ContentLength ?? bytes.length),
      mimeType: head.ContentType ?? mimeType,
      alreadyExisted: true,
    };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
      ?.httpStatusCode;
    if (status !== 404) {
      // Anything other than "not found" is a real error — surface it.
      throw err;
    }
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: mimeType,
      ContentLength: bytes.length,
      ChecksumSHA256: base64FromHex(checksumHex),
      CacheControl: cacheControl ?? 'private, max-age=0',
      Metadata: { 'nexus-channel': channel },
    }),
  );

  return {
    key,
    checksumHex,
    sizeBytes: bytes.length,
    mimeType,
    alreadyExisted: false,
  };
}

/**
 * Generate a short-lived pre-signed GET URL for an R2 object.
 * Used by the admin UI (Phase 5) to preview audio/images.
 */
export async function getSignedDownloadUrl(
  key: string,
  ttlSeconds = 15 * 60,
): Promise<string> {
  const client = getR2Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    { expiresIn: ttlSeconds },
  );
}

function base64FromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
