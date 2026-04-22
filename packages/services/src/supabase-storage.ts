/**
 * Supabase Storage helpers for Inngest functions / admin actions.
 *
 * We deliberately avoid the `@supabase/supabase-js` dependency in this
 * package — it drags cookie / fetch / realtime polyfills we don't need
 * on the Node/Edge runtimes Inngest runs on. The Storage REST surface
 * is small and stable, so a raw fetch is simpler.
 *
 * Callers pass credentials explicitly; no module-level singleton.
 * Mirrors the `r2.ts` helper shape for drop-in substitution in places
 * like `transcribe-attachment.ts`.
 */

export interface SupabaseStorageCreds {
  /** Supabase project URL, e.g. `https://xxx.supabase.co`. */
  url: string;
  /** Service-role key — bypasses RLS, required for private buckets. */
  serviceRoleKey: string;
  /** Bucket name, e.g. `nexus-attachments`. */
  bucket: string;
}

export function supabaseStorageCredsFromEnv(): SupabaseStorageCreds | null {
  // .trim() protects against trailing newlines/whitespace from env vars —
  // a common issue when pasting values into dashboards (we've been bitten
  // by this twice: HMAC secret and bucket name).
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim();
  if (!url || !serviceRoleKey || !bucket) return null;
  return { url, serviceRoleKey, bucket };
}

/**
 * Short-lived signed GET URL for a Supabase Storage object.
 * Default TTL 15 min — long enough for Whisper's longest upload poll
 * but short enough to minimize leak impact.
 *
 * The Storage API returns a path like `/object/sign/<bucket>/<key>?token=...`;
 * we resolve it against `<url>/storage/v1/` to produce an absolute URL the
 * caller can hand straight to a Whisper / AssemblyAI URL-based transcription.
 */
export async function signSupabaseGetUrl(
  creds: SupabaseStorageCreds,
  key: string,
  ttlSeconds = 15 * 60,
): Promise<string> {
  const base = creds.url.replace(/\/+$/, '');
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const endpoint = `${base}/storage/v1/object/sign/${encodeURIComponent(
    creds.bucket,
  )}/${encodedKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds.serviceRoleKey}`,
      apikey: creds.serviceRoleKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: ttlSeconds }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `supabase sign URL failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
    signedURL?: string;
    signedUrl?: string;
  };
  const path = data.signedURL ?? data.signedUrl;
  if (!path) throw new Error('supabase sign URL: missing signedURL in response');

  // `path` is relative like `/object/sign/<bucket>/<key>?token=...`.
  // Resolve against `<base>/storage/v1/` to produce an absolute URL.
  return new URL(path.replace(/^\//, ''), `${base}/storage/v1/`).toString();
}
