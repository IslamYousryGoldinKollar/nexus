import { createServer, type Server } from 'node:http';
import { log } from './logger.js';

/**
 * Tiny HTTP server that serves the current WhatsApp pairing QR as an
 * HTML page with an embedded <img> that auto-refreshes.
 *
 * Why in-process? Because Baileys emits fresh `connection.update.qr`
 * events every ~20s and we need to serve the very latest one. Running
 * this in the same Node process lets us read the in-memory QR directly
 * without IPC.
 *
 * Security: we guard with a shared token (`WA_BRIDGE_QR_TOKEN` — defaults
 * to the HMAC secret) so a random visitor hitting the public URL can't
 * hijack your WhatsApp link.
 */

let _currentQr: string | null = null;
let _currentPairCode: string | null = null;

export function setQr(qr: string | null): void {
  _currentQr = qr;
}

export function setPairCode(code: string | null): void {
  _currentPairCode = code;
}

const PORT = Number(process.env.PORT ?? 8080);

export function startQrServer(token: string): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const provided = url.searchParams.get('t') ?? '';

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          hasQr: !!_currentQr,
          uptimeSec: Math.round(process.uptime()),
          startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        }),
      );
      return;
    }

    if (provided !== token) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('missing or invalid ?t=<token>');
      return;
    }

    if (url.pathname === '/qr.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(_currentQr ?? '(no QR yet — bridge still handshaking)');
      return;
    }

    // POST /restart — process.exit(0) so Fly's restart policy spins a
    // fresh container with a fresh Baileys WebSocket. The watchdog
    // (apps/web/api/admin/wa-watchdog) calls this when it notices no
    // WhatsApp interactions have arrived for the staleness window,
    // covering Baileys' silent-disconnect failure mode where
    // connection.update never fires 'close'.
    if (url.pathname === '/restart' && req.method === 'POST') {
      log.warn('restart.requested');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, restarting: true }));
      // Give the response a tick to flush before exiting.
      setTimeout(() => process.exit(0), 200);
      return;
    }

    // Default: HTML page that auto-refreshes every 5s
    const qrImgUrl = _currentQr
      ? `https://api.qrserver.com/v1/create-qr-code/?size=480x480&ecc=M&margin=10&data=${encodeURIComponent(
          _currentQr,
        )}`
      : null;

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Nexus WA — scan to pair</title>
<meta http-equiv="refresh" content="5">
<style>
  body { font-family: -apple-system,BlinkMacSystemFont,Inter,sans-serif;
         background:#0b0b0c; color:#f4f4f5; margin:0;
         display:flex; flex-direction:column; align-items:center;
         justify-content:center; min-height:100vh; padding:24px; }
  h1 { margin:0 0 8px; font-weight:600; }
  .hint { color:#a1a1aa; font-size:14px; margin:0 0 24px; text-align:center; max-width:480px; }
  img { background:white; padding:12px; border-radius:12px;
        box-shadow:0 10px 40px rgba(0,0,0,.4); max-width:min(90vw,480px); height:auto; }
  .empty { color:#71717a; padding:60px; border:1px dashed #3f3f46; border-radius:12px; }
  .meta { color:#71717a; font-size:12px; margin-top:16px; font-family:ui-monospace,Menlo,monospace; }
  .pair { color:#f4f4f5; font-size:28px; letter-spacing:6px;
          font-family:ui-monospace,Menlo,monospace; background:#18181b;
          padding:16px 28px; border-radius:10px; margin-top:16px; }
</style>
</head>
<body>
<h1>Scan with WhatsApp on your phone</h1>
<p class="hint">WhatsApp → ⋮ (top-right) → Linked devices → Link a device. Point camera at the code. This page refreshes every 5 seconds — the underlying QR rotates every 20 s.</p>
${qrImgUrl
  ? `<img src="${qrImgUrl}" alt="WhatsApp pairing QR" />`
  : `<div class="empty">Bridge is still handshaking with WhatsApp. Refresh in a moment.</div>`}
${_currentPairCode
  ? `<div class="pair">${_currentPairCode}</div><p class="hint">Or enter this 8-character code via "Link with phone number instead".</p>`
  : ''}
<p class="meta">Server time: ${new Date().toISOString()}</p>
</body>
</html>`);
  });

  server.listen(PORT, '0.0.0.0', () => {
    log.info({ port: PORT }, 'qr-server.listening');
  });

  return server;
}
