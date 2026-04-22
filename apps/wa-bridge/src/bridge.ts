import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { useRemoteAuthState } from './auth-store.js';
import { env } from './env.js';
import { log } from './logger.js';
import { setPairCode, setQr } from './qr-server.js';
import {
  forwardMessages,
  type BaileysMessagePayload,
  type ForwardEnvelope,
} from './forward.js';
import { uploadMedia, wipeAuthFiles } from './storage.js';

/**
 * Boot a Baileys socket and plumb it into the Nexus ingest endpoint.
 *
 * Reconnects on transient disconnects; exits the process with code 2 on
 * "logged out" so the host (Fly/Railway) restarts us into a fresh pair-
 * ing flow — the operator sees QR/pair code prompts in the logs.
 */
export async function startBridge(): Promise<void> {
  const { state, saveCreds } = await useRemoteAuthState();
  const { version } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 0] as [number, number, number],
  }));

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // we render our own
    // Baileys pino compatibility: cast is cheap; its type demands its own pino.
    logger: log as unknown as Parameters<typeof makeWASocket>[0]['logger'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ['Nexus', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  // --- Connection lifecycle ---
  let pairCodeRequested = false;
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      log.info('--- pair this device ---');
      qrcode.generate(qr, { small: true });
      // Also expose the raw `qr` string so the operator can paste into
      // any QR generator (e.g. https://www.qrcode-monkey.com/) when the
      // terminal ASCII render is too small to scan.
      log.info({ qrString: qr }, 'qr.raw (paste into any QR generator)');
      // Expose to the in-process HTTP server for browser-scannable view.
      setQr(qr);
      // Phone-number pairing code flow. Baileys is strict about the number
      // format — it must be pure digits (country code + subscriber),
      // no `+`, no spaces, no dashes. We normalize defensively.
      //
      // Only request ONCE per connection. Re-requesting on each QR refresh
      // churns WA's rate limiter and has been seen to cause "couldn't link"
      // on the phone side.
      if (env.pairPhoneNumber && !sock.authState.creds.registered && !pairCodeRequested) {
        pairCodeRequested = true;
        const digitsOnly = env.pairPhoneNumber.replace(/\D+/g, '');
        try {
          const code = await sock.requestPairingCode(digitsOnly);
          setPairCode(code);
          log.info(
            { pairingCode: code, number: digitsOnly },
            'pair-code.ready (enter in WhatsApp → Linked Devices)',
          );
        } catch (err) {
          log.warn(
            { err: (err as Error).message, number: digitsOnly },
            'pair-code.failed (fall back to QR scan above)',
          );
        }
      }
    }
    if (connection === 'open') {
      log.info({ me: sock.user?.id }, 'connection.open');
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log.warn({ statusCode, loggedOut }, 'connection.close');
      if (loggedOut) {
        log.error('session invalidated — wiping remote auth + restarting clean');
        try {
          const n = await wipeAuthFiles();
          log.info({ deleted: n }, 'auth.wiped');
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'auth.wipe.failed');
        }
        // Let Fly restart the machine; on next boot hydrate will be empty
        // and a fresh QR/pair-code cycle begins.
        process.exit(2);
      }
      // Transient — let the process manager restart us (or reconnect inline)
      setTimeout(() => startBridge().catch((e) => log.error(e)), 2_000);
    }
  });

  // --- Inbound messages ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const payloads: BaileysMessagePayload[] = [];
    for (const m of messages) {
      try {
        const p = await normalize(sock, m);
        if (p) payloads.push(p);
      } catch (err) {
        log.error(
          { id: m.key.id, err: (err as Error).message },
          'normalize.failed',
        );
      }
    }
    if (payloads.length === 0) return;
    const envelope: ForwardEnvelope = {
      source: 'baileys',
      device: sock.user?.id ?? 'unknown',
      receivedAt: new Date().toISOString(),
      messages: payloads,
    };
    await forwardMessages(envelope);
  });
}

/**
 * Convert a Baileys `WAMessage` into our wire-format payload. Media is
 * downloaded and pushed to Supabase Storage inline — the Vercel endpoint
 * only sees keys, never raw bytes, so it stays fast.
 */
async function normalize(
  sock: WASocket,
  m: WAMessage,
): Promise<BaileysMessagePayload | null> {
  // Ignore protocol / empty / reaction messages — low signal, high volume.
  const msg = m.message;
  if (!msg || m.key.remoteJid === 'status@broadcast') return null;

  const id = m.key.id ?? '';
  const from = m.key.remoteJid ?? '';
  const fromMe = Boolean(m.key.fromMe);
  const timestamp = Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000));

  // Identify the message branch and derive text/media.
  if (msg.conversation) {
    return {
      id,
      from,
      fromMe,
      timestamp,
      type: 'text',
      text: msg.conversation,
      raw: m,
    };
  }
  if (msg.extendedTextMessage?.text) {
    return {
      id,
      from,
      fromMe,
      timestamp,
      type: 'text',
      text: msg.extendedTextMessage.text,
      raw: m,
    };
  }
  if (msg.imageMessage || msg.audioMessage || msg.videoMessage || msg.documentMessage || msg.stickerMessage) {
    const kind = msg.imageMessage
      ? 'image'
      : msg.audioMessage
      ? 'audio'
      : msg.videoMessage
      ? 'video'
      : msg.stickerMessage
      ? 'sticker'
      : 'document';
    const caption =
      msg.imageMessage?.caption ??
      msg.videoMessage?.caption ??
      msg.documentMessage?.caption ??
      null;
    const mime =
      msg.imageMessage?.mimetype ??
      msg.audioMessage?.mimetype ??
      msg.videoMessage?.mimetype ??
      msg.documentMessage?.mimetype ??
      msg.stickerMessage?.mimetype ??
      'application/octet-stream';
    const filename = msg.documentMessage?.fileName ?? undefined;

    // downloadMediaMessage handles chunked fetch + decryption.
    // The 4th-arg context contract is unstable across Baileys minor
    // versions; cast to silence over-strict inference without forcing a
    // pin here.
    const buf = (await downloadMediaMessage(
      m,
      'buffer',
      {},
      {
        logger: log,
        reuploadRequest: sock.updateMediaMessage,
      } as Parameters<typeof downloadMediaMessage>[3],
    )) as Buffer;

    const uploaded = await uploadMedia({
      bytes: new Uint8Array(buf),
      mimeType: mime,
      occurredAt: new Date(timestamp * 1000),
    });

    return {
      id,
      from,
      fromMe,
      timestamp,
      type: kind,
      text: caption,
      media: {
        storageKey: uploaded.key,
        mimeType: uploaded.mimeType,
        sizeBytes: uploaded.sizeBytes,
        checksumHex: uploaded.checksumHex,
        filename,
      },
      raw: m,
    };
  }
  if (msg.locationMessage) {
    const loc = msg.locationMessage;
    return {
      id,
      from,
      fromMe,
      timestamp,
      type: 'location',
      text: [loc.name, loc.address].filter(Boolean).join(' · ') || null,
      location: {
        latitude: Number(loc.degreesLatitude ?? 0),
        longitude: Number(loc.degreesLongitude ?? 0),
        name: loc.name ?? undefined,
        address: loc.address ?? undefined,
      },
      raw: m,
    };
  }
  // Low-signal — swallow for now.
  return null;
}
