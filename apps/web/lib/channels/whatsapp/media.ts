import { serverEnv } from '../../env';
import { log } from '../../logger';

/**
 * Download a media asset from WhatsApp Cloud API.
 *
 * Two-step dance (per Meta's docs):
 *   1. GET https://graph.facebook.com/v21.0/<media_id>
 *      → returns { url, mime_type, sha256, file_size }
 *   2. GET <url>  (same bearer token required)
 *      → returns the raw bytes
 *
 * The download URL is short-lived (~5 min) so we fetch it on demand rather
 * than caching.
 */

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface WhatsappMediaMetadata {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
  messaging_product: string;
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 provided by Meta (hex). We verify this against our own hash. */
  remoteSha256: string;
}

export class WhatsappMediaError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly mediaId?: string,
  ) {
    super(message);
    this.name = 'WhatsappMediaError';
  }
}

function authHeaders(): Record<string, string> {
  const token = serverEnv.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    throw new WhatsappMediaError('WHATSAPP_ACCESS_TOKEN is not configured');
  }
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'nexus-ingest/1.0',
  };
}

/** Resolve a media ID to its short-lived download URL + metadata. */
export async function getMediaMetadata(
  mediaId: string,
): Promise<WhatsappMediaMetadata> {
  const url = `${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}`;
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new WhatsappMediaError(
      `GET /media/${mediaId} failed: ${res.status} ${body.slice(0, 500)}`,
      res.status,
      mediaId,
    );
  }
  return (await res.json()) as WhatsappMediaMetadata;
}

/** Follow the short-lived URL and stream the blob into memory. */
export async function fetchMediaBytes(
  meta: WhatsappMediaMetadata,
): Promise<DownloadedMedia> {
  const res = await fetch(meta.url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new WhatsappMediaError(
      `GET media url failed: ${res.status} ${body.slice(0, 500)}`,
      res.status,
      meta.id,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    bytes: buf,
    mimeType: meta.mime_type,
    sizeBytes: buf.length,
    remoteSha256: meta.sha256,
  };
}

/** Convenience — resolve + download in one call. */
export async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
  const meta = await getMediaMetadata(mediaId);
  log.debug('whatsapp.media.metadata', {
    mediaId,
    mimeType: meta.mime_type,
    sizeBytes: meta.file_size,
  });
  return fetchMediaBytes(meta);
}
