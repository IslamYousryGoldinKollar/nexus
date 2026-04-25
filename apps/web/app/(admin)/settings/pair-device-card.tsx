'use client';

import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';

interface PairResponse {
  code: string;
  expiresAt: string;
  ttlMinutes: number;
}

/**
 * Pair-new-device card for the Settings page.
 *
 * Click "Generate code" → POST /api/devices/pair-init → display the
 * 6-character code + a scannable QR (rendered by the free
 * api.qrserver.com — code is short-lived and ephemeral so the privacy
 * trade-off is acceptable). The Android app's QrScanner reads any QR
 * containing plain text, so the QR encodes just the code.
 */
export function PairDeviceCard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);

  // Tick down the countdown.
  useEffect(() => {
    if (!pairing) return;
    const tick = () => {
      const ms = new Date(pairing.expiresAt).getTime() - Date.now();
      setSecondsLeft(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pairing]);

  async function generate() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/devices/pair-init', { method: 'POST' });
      const body = (await res.json()) as PairResponse | { error: string; hint?: string };
      if (!res.ok) {
        const msg =
          'error' in body
            ? `${body.error}${'hint' in body && body.hint ? ` — ${body.hint}` : ''}`
            : 'failed to generate pairing code';
        throw new Error(msg);
      }
      setPairing(body as PairResponse);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPairing(null);
    setError(null);
    setSecondsLeft(0);
  }

  const expired = pairing != null && secondsLeft === 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Smartphone className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Pair new device</h2>
          </div>
          <p className="ml-6 mt-1 text-xs text-muted-foreground">
            Generates a one-time 6-character code valid for 10 minutes. Scan the QR or type the
            code on the Android app&apos;s pairing screen.
          </p>
        </div>
        {pairing && !expired && (
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
          >
            New code
          </button>
        )}
      </div>

      {!pairing && (
        <div className="border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Generating…' : 'Generate code'}
          </button>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      )}

      {pairing && (
        <div className="border-t border-border px-5 py-5">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt="Pairing QR code"
                className="size-44 rounded-md border border-border bg-white p-1"
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&qzone=2&data=${encodeURIComponent(
                  pairing.code,
                )}`}
              />
              <p className="text-xs text-muted-foreground">Scan from the Android app</p>
            </div>

            <div className="flex flex-col items-center gap-3 sm:items-start">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Or type this code
                </p>
                <p className="mt-1 font-mono text-3xl font-semibold tracking-[0.4em]">
                  {pairing.code}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {expired
                  ? 'Expired — generate a new one.'
                  : `Expires in ${formatTime(secondsLeft)}`}
              </p>
              {expired && (
                <button
                  type="button"
                  onClick={generate}
                  disabled={loading}
                  className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  Generate again
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
