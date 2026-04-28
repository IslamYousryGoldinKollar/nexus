'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

export interface MergeRow {
  id: string;
  displayName: string;
  identifierLabels: string[]; // e.g. ["email=lidia@…", "whatsapp_wa_id=…"]
  injazPartyName: string | null;
  sessionCount: number;
  /**
   * The actual <tr> children — rendered server-side then handed to us
   * so we don't have to re-implement every cell. We add merge-mode
   * columns *around* this fragment.
   */
  rowMarkup: ReactNode;
}

/**
 * Client-side wrapper for the Contacts table that adds an opt-in
 * "merge mode" controlled at the top. In merge mode each row gets:
 *   - a "Keep" radio (one row only — the survivor)
 *   - a "Drop" checkbox (any number)
 * Confirm fires POST /api/contacts/merge which re-parents identifiers
 * and sessions then deletes the dropped rows in a single transaction.
 *
 * State is local. On success we router.refresh() so the page server-
 * renders fresh contacts list.
 */
export default function ContactsTableMerge({
  rows,
  headerCells,
}: {
  rows: MergeRow[];
  headerCells: ReactNode;
}) {
  const router = useRouter();
  const [mode, setMode] = useState(false);
  const [keep, setKeep] = useState<string | null>(null);
  const [drop, setDrop] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setMode(false);
    setKeep(null);
    setDrop(new Set());
    setError(null);
  }

  function pickKeep(id: string) {
    setKeep((cur) => (cur === id ? null : id));
    setDrop((cur) => {
      const n = new Set(cur);
      n.delete(id);
      return n;
    });
  }

  function toggleDrop(id: string) {
    if (keep === id) return;
    setDrop((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const dropList = Array.from(drop);
  const canMerge = keep !== null && dropList.length > 0;

  async function doMerge() {
    if (!keep || !dropList.length) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/contacts/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keep, drop: dropList }),
        });
        const json = (await res.json()) as { error?: string; ok?: true };
        if (!res.ok || !json.ok) {
          setError(json.error ?? `merge failed (${res.status})`);
          return;
        }
        reset();
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      {!mode ? (
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => setMode(true)}
            className="rounded-md border border-border bg-background px-3 py-1.5 hover:bg-muted"
          >
            Merge contacts…
          </button>
          <span className="text-muted-foreground">
            Combine duplicate rows from email / WhatsApp / phone.
          </span>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">Merge mode</span>
            <span className="text-muted-foreground">
              {keep
                ? `Keeping 1 + dropping ${dropList.length}`
                : 'Pick a "keep" row, then check rows to drop.'}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={!canMerge || pending}
                onClick={doMerge}
                className="rounded-md bg-amber-500 px-3 py-1.5 font-medium text-amber-950 disabled:opacity-50"
              >
                {pending ? 'Merging…' : `Merge ${dropList.length} → 1`}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={reset}
                className="rounded-md border border-border bg-background px-3 py-1.5 hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
          {error && (
            <div className="mt-2 text-sm text-destructive">Error: {error}</div>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {mode && (
                <>
                  <th className="px-3 py-2 text-center font-medium">Keep</th>
                  <th className="px-3 py-2 text-center font-medium">Drop</th>
                </>
              )}
              {headerCells}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const isKeep = keep === row.id;
              const isDrop = drop.has(row.id);
              const rowClass = isKeep
                ? 'bg-emerald-500/10'
                : isDrop
                  ? 'bg-rose-500/10 opacity-70'
                  : '';
              return (
                <tr key={row.id} className={rowClass}>
                  {mode && (
                    <>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="radio"
                          name="merge-keep"
                          checked={isKeep}
                          onChange={() => pickKeep(row.id)}
                          aria-label={`Keep ${row.displayName}`}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={isDrop}
                          disabled={isKeep}
                          onChange={() => toggleDrop(row.id)}
                          aria-label={`Drop ${row.displayName}`}
                        />
                      </td>
                    </>
                  )}
                  {row.rowMarkup}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
