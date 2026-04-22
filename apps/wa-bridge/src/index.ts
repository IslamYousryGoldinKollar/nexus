import { startBridge } from './bridge.js';
import { env } from './env.js';
import { log } from './logger.js';
import { startQrServer } from './qr-server.js';

/**
 * Entry point. Any top-level throw exits with code 1 so the host
 * restarts us cleanly.
 */

// Public QR server runs on $PORT (8080 on Fly). Token-gated so a random
// visitor can't hijack your WhatsApp link. Defaults to the HMAC secret —
// you already have that value, no extra config needed.
const qrToken = process.env.WA_BRIDGE_QR_TOKEN ?? env.hmacSecret;
startQrServer(qrToken);

startBridge().catch((err) => {
  log.error({ err: (err as Error).stack ?? (err as Error).message }, 'bridge.fatal');
  process.exit(1);
});

// Graceful shutdown: let in-flight Storage uploads drain for ~2s.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutdown');
    setTimeout(() => process.exit(0), 2_000);
  });
}
