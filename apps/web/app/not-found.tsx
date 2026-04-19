import Link from 'next/link';

/**
 * App Router 404 page. Without this file, Next 15.5 falls back to the
 * Pages Router `_error` page which triggers "<Html> should not be
 * imported outside of pages/_document" during `next build`.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">404 — Not found</h1>
      <p className="text-muted-foreground">
        The page you are looking for does not exist.
      </p>
      <Link href="/" className="underline">
        Return home
      </Link>
    </main>
  );
}
