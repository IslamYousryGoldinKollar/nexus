/**
 * Structured logger with optional Axiom + Sentry shipping.
 *
 * - Always: one JSON object per line to stdout (Vercel collects).
 * - If `AXIOM_TOKEN` set: ships to Axiom dataset `AXIOM_DATASET`
 *   in fire-and-forget batches (200 ms or 50 events, whichever first).
 * - If `SENTRY_DSN` set + level >= warn: forwards to Sentry breadcrumbs;
 *   `error` level captures an exception (best-effort — silent if @sentry/node
 *   not initialized).
 * - If a `runWithRequestId(...)` scope is active, every emitted event is
 *   automatically tagged with `request_id` for cross-log correlation.
 *
 * The Axiom transport uses `fetch` directly so it works in Edge runtimes.
 */
import { getCurrentRequestId } from './request-id';

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogEvent {
  ts: string;
  level: Level;
  event: string;
  [k: string]: unknown;
}

// ---- Axiom transport -----------------------------------------------------

const AXIOM_BUFFER: LogEvent[] = [];
let axiomFlushTimer: ReturnType<typeof setTimeout> | null = null;
const AXIOM_FLUSH_MS = 200;
const AXIOM_MAX_BATCH = 50;

async function flushAxiom(): Promise<void> {
  axiomFlushTimer = null;
  if (AXIOM_BUFFER.length === 0) return;
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET ?? 'nexus';
  if (!token) {
    AXIOM_BUFFER.length = 0;
    return;
  }
  const events = AXIOM_BUFFER.splice(0, AXIOM_BUFFER.length);
  try {
    await fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-ndjson',
      },
      body: events.map((e) => JSON.stringify(e)).join('\n'),
      // Axiom is best-effort; don't block the request.
      keepalive: true,
    });
  } catch {
    // Swallow — don't crash the request because logging failed.
  }
}

function enqueueAxiom(event: LogEvent): void {
  AXIOM_BUFFER.push(event);
  if (AXIOM_BUFFER.length >= AXIOM_MAX_BATCH) {
    void flushAxiom();
    return;
  }
  if (!axiomFlushTimer) axiomFlushTimer = setTimeout(() => void flushAxiom(), AXIOM_FLUSH_MS);
}

// ---- Sentry pass-through (lazy, optional) --------------------------------

type SentryShim = {
  captureException?: (e: unknown, ctx?: Record<string, unknown>) => void;
  captureMessage?: (m: string, level?: string) => void;
  addBreadcrumb?: (b: Record<string, unknown>) => void;
};

function getSentry(): SentryShim | null {
  const g = globalThis as { __SENTRY__?: { hub?: { getClient?: () => unknown } } };
  if (!g.__SENTRY__) return null;
  // We deliberately don't `import @sentry/node` here — it's wired via
  // `instrumentation.ts` and exposes itself on globalThis. This keeps
  // edge-runtime bundles thin.
  const sentryGlobal = (globalThis as { Sentry?: SentryShim }).Sentry;
  return sentryGlobal ?? null;
}

function forwardToSentry(level: Level, event: string, fields: Record<string, unknown>): void {
  if (level === 'debug' || level === 'info') return;
  const sentry = getSentry();
  if (!sentry) return;
  try {
    sentry.addBreadcrumb?.({ category: 'log', level, message: event, data: fields });
    if (level === 'error') {
      const err = fields.err instanceof Error ? fields.err : new Error(`${event}: ${fields.message ?? ''}`);
      sentry.captureException?.(err, { extra: fields });
    }
  } catch {
    // Sentry is best-effort.
  }
}

// ---- Stdout transport (always on) ---------------------------------------

function emit(level: Level, event: string, fields: Record<string, unknown>): void {
  const requestId = getCurrentRequestId();
  const evt: LogEvent = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(requestId ? { request_id: requestId } : {}),
    ...fields,
  };
  const line = JSON.stringify(evt);
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  enqueueAxiom(evt);
  forwardToSentry(level, event, fields);
}

// ---- Public API ----------------------------------------------------------

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
  /** Force-flush the Axiom buffer. Call from health checks or graceful shutdown. */
  async flush(): Promise<void> {
    await flushAxiom();
  },
};
