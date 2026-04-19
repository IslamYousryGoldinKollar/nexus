'use client';

/**
 * App Router global error boundary. Required in Next 15.5 to prevent
 * the Pages Router fallback (`_error.js` → `_document.js`) from being
 * generated during `next build`, which triggers the spurious
 * "<Html> should not be imported outside of pages/_document" error.
 *
 * Must include <html> and <body> because it wraps the root layout when
 * the top-level layout itself crashes.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="text-sm text-gray-500">{error.message}</p>
          {error.digest ? (
            <p className="text-xs text-gray-400">Digest: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            className="rounded bg-black px-4 py-2 text-sm text-white"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
