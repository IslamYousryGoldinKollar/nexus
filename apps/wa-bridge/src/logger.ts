import pino from 'pino';
import { env } from './env.js';

/**
 * Pino logger configured for structured JSON in prod and pretty text in
 * dev. Level is driven by LOG_LEVEL (default "info"). Baileys also takes
 * its own pino instance — we share ours so all context lands in the same
 * log stream.
 */
export const log = pino({
  level: env.logLevel,
  base: { app: 'wa-bridge' },
  redact: {
    paths: [
      'req.headers.authorization',
      'res.headers["x-nexus-signature"]',
      '*.signingKey',
      '*.noiseKey',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof log;
