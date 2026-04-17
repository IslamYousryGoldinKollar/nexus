/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line to `stdout` so Vercel + Axiom + grep all
 * work. Add Sentry/Datadog integrations here when they are wired up.
 *
 * Usage:
 *   log.info('whatsapp.webhook.received', { channel: 'whatsapp', msgId });
 *   log.error('whatsapp.webhook.failed', { err: e.message, stack: e.stack });
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, event: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export const log = {
  debug(event: string, fields: Record<string, unknown> = {}) {
    if (process.env.NODE_ENV !== 'production') emit('debug', event, fields);
  },
  info(event: string, fields: Record<string, unknown> = {}) {
    emit('info', event, fields);
  },
  warn(event: string, fields: Record<string, unknown> = {}) {
    emit('warn', event, fields);
  },
  error(event: string, fields: Record<string, unknown> = {}) {
    emit('error', event, fields);
  },
};
