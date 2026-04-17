import Link from 'next/link';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-8 px-6">
      <div className="inline-flex items-center gap-3">
        <span className="size-2 rounded-full bg-primary" />
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          Nexus · GoldinKollar
        </span>
      </div>
      <h1 className="text-4xl font-semibold leading-tight">
        AI Chief of Staff.
        <br />
        <span className="text-muted-foreground">
          Context-aware. Human-approved. Always in the loop.
        </span>
      </h1>
      <p className="max-w-prose text-base leading-relaxed text-muted-foreground">
        Phase 0 skeleton is live. Ingestion, reasoning, approvals, and mobile follow.
      </p>
      <div className="flex gap-3 text-sm">
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 font-medium text-primary-foreground transition hover:opacity-90"
        >
          Admin console
        </Link>
        <Link
          href="/api/health"
          className="inline-flex h-10 items-center rounded-md border border-border bg-card px-4 font-medium text-foreground transition hover:bg-accent"
        >
          Health check
        </Link>
      </div>
    </main>
  );
}
