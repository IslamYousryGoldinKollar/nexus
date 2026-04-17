import { serverEnv } from '../../env';
import { log } from '../../logger';

/**
 * Download a file from Telegram.
 *
 * Two-step:
 *   1. POST https://api.telegram.org/bot<token>/getFile?file_id=<file_id>
 *      → { file_path, file_size }
 *   2. GET  https://api.telegram.org/file/bot<token>/<file_path>
 *      → raw bytes
 *
 * Telegram caps files at 20 MB via Bot API (up to 2 GB via TDLib).
 * For the voice notes + images we care about, 20 MB is plenty.
 */

export class TelegramMediaError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly fileId?: string,
  ) {
    super(message);
    this.name = 'TelegramMediaError';
  }
}

interface TelegramFileResponse {
  ok: boolean;
  result?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
  };
  description?: string;
}

function botToken(): string {
  const token = serverEnv.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramMediaError('TELEGRAM_BOT_TOKEN is not configured');
  return token;
}

export async function getFilePath(fileId: string): Promise<string> {
  const token = botToken();
  const url = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(
    fileId,
  )}`;
  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as TelegramFileResponse | null;

  if (!res.ok || !body?.ok || !body.result?.file_path) {
    throw new TelegramMediaError(
      `getFile failed: ${res.status} ${body?.description ?? ''}`,
      res.status,
      fileId,
    );
  }
  return body.result.file_path;
}

export interface DownloadedTelegramFile {
  bytes: Uint8Array;
  sizeBytes: number;
  mimeType?: string;
}

export async function downloadFile(
  fileId: string,
  mimeHint?: string,
): Promise<DownloadedTelegramFile> {
  const path = await getFilePath(fileId);
  const token = botToken();
  const url = `https://api.telegram.org/file/bot${token}/${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new TelegramMediaError(
      `file download failed: ${res.status}`,
      res.status,
      fileId,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = res.headers.get('content-type') ?? mimeHint;
  log.debug('telegram.media.downloaded', { fileId, sizeBytes: bytes.length, mime });
  return {
    bytes,
    sizeBytes: bytes.length,
    mimeType: mime ?? undefined,
  };
}
