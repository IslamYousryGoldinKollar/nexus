/**
 * Server-side Sentry init.
 *
 * Loaded by `instrumentation.ts` once per worker. Sampled at 5% in prod,
 * 100% in dev. Sensitive headers scrubbed via `beforeSend`.
 *
 * `@sentry/node` is intentionally an OPTIONAL dependency (not in
 * package.json). If it isn't installed, this module silently no-ops so
 * deployments without Sentry still boot.
 *   pnpm --filter @nexus/web add @sentry/node
 */

interface SentryLike {
  init: (cfg: Record<string, unknown>) => void;
}

export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  let mod: unknown;
  try {
    // String-literal `as string` defeats TS module-resolution at compile time.
    mod = await import(/* webpackIgnore: true */ '@sentry/node' as string);
  } catch {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'sentry.skip.not_installed',
        ts: new Date().toISOString(),
      }),
    );
    return;
  }

  const Sentry = mod as SentryLike;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.05 : 1.0,
    profilesSampleRate: 0,
    beforeSend(event: { request?: { headers?: Record<string, unknown> } }) {
      if (event.request?.headers) {
        const h = event.request.headers;
        delete h['authorization'];
        delete h['cookie'];
        delete h['x-telegram-bot-api-secret-token'];
      }
      return event;
    },
  });

  // Expose for the logger to forward breadcrumbs to.
  (globalThis as { Sentry?: unknown }).Sentry = Sentry;
}
