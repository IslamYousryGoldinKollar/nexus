import { startBridge } from './bridge.js';
import { log } from './logger.js';

/**
 * Entry point. Any top-level throw exits with code 1 so the host
 * restarts us cleanly.
 */
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
