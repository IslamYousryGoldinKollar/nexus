'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

interface Props {
  contactId: string;
  initialPartyName: string | null;
  initialProjectName: string | null;
}

interface Party {
  name: string;
}

interface Project {
  name: string;
  client: string | null;
}

/**
 * Two coupled selects per contact row: party (Injaz client) and
 * project. Selecting a party filters the project list to that party's
 * projects (Injaz returns the client name on each project record).
 *
 * Saves on every change, debounced via the disabled flag while the
 * PATCH is in flight. Lists fetch lazily on first focus to keep the
 * page render cheap when there are dozens of contacts.
 */
export default function ContactInjazMapping({
  contactId,
  initialPartyName,
  initialProjectName,
}: Props) {
  const [partyName, setPartyName] = useState<string | null>(initialPartyName);
  const [projectName, setProjectName] = useState<string | null>(initialProjectName);
  const [parties, setParties] = useState<Party[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load both lists the first time the user interacts.
  async function ensureLists(): Promise<void> {
    if (parties && projects) return;
    try {
      const [pRes, prRes] = await Promise.all([
        parties ? null : fetch('/api/injaz/parties'),
        projects ? null : fetch('/api/injaz/projects'),
      ]);
      if (pRes && pRes.ok) {
        const data = (await pRes.json()) as { parties: Party[] };
        setParties(data.parties);
      }
      if (prRes && prRes.ok) {
        const data = (await prRes.json()) as { projects: Project[] };
        setProjects(data.projects);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    // Refresh lists if the contact's mapping was edited elsewhere — cheap
    // because /api/injaz/* is in-process cached for 5 min.
    void ensureLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(next: { party: string | null; project: string | null }): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}/injaz`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          injazPartyName: next.party,
          injazProjectName: next.project,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function onPartyChange(value: string): void {
    const next = value === '' ? null : value;
    setPartyName(next);
    // Clearing the party also clears the project (it would be orphaned).
    if (next === null && projectName !== null) {
      setProjectName(null);
      void save({ party: null, project: null });
    } else {
      void save({ party: next, project: projectName });
    }
  }

  function onProjectChange(value: string): void {
    const next = value === '' ? null : value;
    setProjectName(next);
    void save({ party: partyName, project: next });
  }

  // Filter projects to those linked to the selected party. Projects
  // without a client (Injaz returns "—" → we surface as null) appear
  // when no party is selected.
  const filteredProjects = projects
    ? partyName
      ? projects.filter((p) => p.client === partyName)
      : projects
    : [];

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex gap-1">
        <select
          value={partyName ?? ''}
          onChange={(e) => onPartyChange(e.target.value)}
          onFocus={() => void ensureLists()}
          disabled={loading}
          className="min-w-0 max-w-[140px] truncate rounded-md border border-border bg-background px-1.5 py-1 text-xs disabled:opacity-50"
          title={partyName ?? '— pick client —'}
        >
          <option value="">— client —</option>
          {parties?.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={projectName ?? ''}
          onChange={(e) => onProjectChange(e.target.value)}
          onFocus={() => void ensureLists()}
          disabled={loading || !parties}
          className="min-w-0 max-w-[160px] truncate rounded-md border border-border bg-background px-1.5 py-1 text-xs disabled:opacity-50"
          title={projectName ?? '— pick project —'}
        >
          <option value="">— project —</option>
          {filteredProjects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>
      {error && <span className="text-[10px] text-destructive">{error}</span>}
    </div>
  );
}
