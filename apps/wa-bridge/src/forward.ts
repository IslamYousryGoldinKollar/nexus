import { createHmac } from 'node:crypto';
import { env } from './env.js';
import { log } from './logger.js';

/**
 * HMAC-signed POST of a normalized WhatsApp event to the Nexus API.
 *
 * The signature is computed on the raw request body and sent as
 * `X-Nexus-Signature: sha256=<hex>`. This mirrors the Meta webhook
 * contract so existing verification helpers can be reused server-side.
 *
 * Retries: 3 attempts with exponential backoff (250 ms, 1 s, 4 s).
 * After the final failure we swallow the error and log — the Nexus
 * side idempotency guard means a later replay (if we ever add one)
 * won't double-insert.
 */

export interface BaileysMessagePayload {
  id: string;
  from: string;
  fromMe: boolean;
  timestamp: number;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contact' | 'unknown';
  text: string | null;
  /**
   * If the message had media, the bridge uploaded bytes to Supabase
   * Storage and set these fields. The server records an attachment row
   * referencing this key (no further download needed).
   */
  media?: {
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    checksumHex: string;
    filename?: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  raw?: unknown;
}

export interface ForwardEnvelope {
  source: 'baileys';
  device: string;
  receivedAt: string;
  messages: BaileysMessagePayload[];
}

function sign(raw: string): string {
  return 'sha256=' + createHmac('sha256', env.hmacSecret).update(raw).digest('hex');
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function forwardMessages(envelope: ForwardEnvelope): Promise<void> {
  if (env.dryRun) {
    log.info({ count: envelope.messages.length, dryRun: true }, 'forward.skipped');
    return;
  }

  const body = JSON.stringify(envelope);
  const signature = sign(body);
  const url = `${env.nexusApiUrl}/api/ingest/whatsapp-baileys`;

  const delays = [0, 250, 1000, 4000] as const;
  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const wait = delays[attempt] ?? 0;
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nexus-signature': signature,
          'user-agent': 'nexus-wa-bridge/0.1',
        },
        body,
      });
      if (res.ok) {
        log.debug({ count: envelope.messages.length, attempt }, 'forward.ok');
        return;
      }
      const txt = await res.text().catch(() => '');
      lastErr = new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      // 4xx (not 429) means the server rejected the payload; no retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        log.error({ status: res.status, err: txt.slice(0, 200) }, 'forward.rejected');
        return;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  log.error({ err: (lastErr as Error)?.message }, 'forward.failed');
}
