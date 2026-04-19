'use client';

import { useState } from 'react';
import { Loader2, Mail } from 'lucide-react';

/**
 * Login page. Email-only — magic link via Resend.
 *
 * UX intent:
 *   - Single textbox, large submit, instant feedback
 *   - Always show success message (don't reveal whether email is on allowlist)
 *   - Show URL error param (?error=expired_or_invalid) under the form
 */

export default function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; next?: string }>;
}) {
  return <LoginForm searchParamsPromise={searchParams} />;
}

function LoginForm({
  searchParamsPromise,
}: {
  searchParamsPromise?: Promise<{ error?: string; next?: string }>;
}) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Read URL params once on mount.
  if (typeof window !== 'undefined' && urlError === null && searchParamsPromise) {
    searchParamsPromise.then((sp) => sp?.error && setUrlError(sp.error)).catch(() => {});
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        setError('Server error — try again in a moment.');
      } else {
        setSent(true);
      }
    } catch {
      setError('Network error — check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="inline-block size-2 rounded-full bg-primary" />
          <h1 className="text-lg font-semibold tracking-tight">Nexus</h1>
          <span className="text-xs text-muted-foreground">admin</span>
        </div>

        {sent ? (
          <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
            <p className="font-medium">Check your email.</p>
            <p className="mt-2 text-muted-foreground">
              If <code className="rounded bg-background px-1">{email}</code> is on the
              allowlist, a sign-in link is on its way. The link expires in 15 minutes.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Email
              </span>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="islam.yousry@goldinkollar.com"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary"
              />
            </label>
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Mail className="size-4" />
              )}
              Send sign-in link
            </button>
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
            {urlError && (
              <p className="text-xs text-destructive">
                {urlError === 'expired_or_invalid'
                  ? 'That link has expired or has already been used.'
                  : urlError === 'not_allowed'
                    ? 'This email is not on the admin allowlist.'
                    : urlError === 'missing_token'
                      ? 'No sign-in token found in the link.'
                      : 'Sign-in failed. Please try again.'}
              </p>
            )}
          </form>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Magic-link sign-in. No passwords.
        </p>
      </div>
    </div>
  );
}
