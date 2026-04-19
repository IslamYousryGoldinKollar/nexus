/**
 * Next.js 15 instrumentation hook — runs once per cold start.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initSentry } = await import('./sentry.server.config');
    await initSentry();
  }
}
