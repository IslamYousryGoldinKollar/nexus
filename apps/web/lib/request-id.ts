import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'crypto';

/**
 * Generate a unique request ID for tracing requests through the system.
 * Format: <timestamp>-<random>
 *
 * Used for distributed tracing and debugging across API calls, webhooks, and background jobs.
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString('hex');
  return `${timestamp}-${random}`;
}

/**
 * Extract or generate a request ID from headers.
 * If the X-Request-ID header is present, use it. Otherwise, generate a new one.
 */
export function getOrCreateRequestId(headers: Headers): string {
  const existing = headers.get('x-request-id');
  if (existing && existing.length > 0 && existing.length < 100) {
    return existing;
  }
  return generateRequestId();
}

/**
 * Per-request AsyncLocalStorage. The logger reads from this so any
 * `log.*()` call inside a `runWithRequestId(...)` scope automatically
 * tags its output with `request_id`.
 *
 * Routes opt in by wrapping their handler body:
 *   const id = getOrCreateRequestId(req.headers);
 *   return runWithRequestId(id, async () => { ...handler... });
 */
const requestIdStore = new AsyncLocalStorage<string>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestIdStore.run(requestId, fn);
}

export function getCurrentRequestId(): string | undefined {
  try {
    return requestIdStore.getStore();
  } catch {
    return undefined;
  }
}
