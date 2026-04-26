'use client';

import { useEffect, useState } from 'react';

interface InjazUser {
  name: string;
  email: string;
  role: string;
}

interface Props {
  /** AI's guess from reasoning. Used to preselect when it matches a known user. */
  guess?: string | null;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

/**
 * Self-contained dropdown of approved Injaz users (employees). The
 * value is the user's display NAME, because the MCP create_task tool
 * takes `assigneeName` (string), not an ID. Lazy-loads on first focus.
 *
 * Empty value = "no override" — the sync cron falls back to the AI's
 * assigneeGuess. Pre-selects the AI guess when it matches a real user
 * exactly (case-sensitive — Injaz is the source of truth on spelling).
 */
export default function AssigneePicker({ guess, value, onChange, disabled }: Props) {
  const [users, setUsers] = useState<InjazUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadUsers(): Promise<void> {
    if (users !== null) return;
    try {
      const res = await fetch('/api/injaz/users');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { users: InjazUser[] };
      setUsers(data.users);

      // If we don't have an explicit value but the AI's guess matches a
      // real user, pre-select it so the operator can just hit Approve.
      if (!value && guess) {
        const match = data.users.find((u) => u.name === guess || u.email === guess);
        if (match) onChange(match.name);
      }
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    void loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Assignee
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
      >
        <option value="">— pick employee —</option>
        {users?.map((u) => (
          <option key={u.email} value={u.name}>
            {u.name} ({u.role.toLowerCase()})
          </option>
        ))}
      </select>
      {loadError && <span className="text-[10px] text-destructive">{loadError}</span>}
      {guess && !value && (
        <span className="text-[10px] text-muted-foreground">AI guess: {guess}</span>
      )}
    </div>
  );
}
