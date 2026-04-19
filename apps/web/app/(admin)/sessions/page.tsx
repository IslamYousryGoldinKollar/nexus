import Link from 'next/link';
import { MessagesSquare } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelative } from '@/components/ui/format';
import { StateBadge } from '@/components/ui/state-badge';
import { listSessions } from '@/lib/queries/sessions-list';

export const dynamic = 'force-dynamic';

const STATES = [
  { v: undefined, label: 'All' },
  { v: 'open' as const, label: 'Open' },
  { v: 'awaiting_approval' as const, label: 'Awaiting' },
  { v: 'approved' as const, label: 'Approved' },
  { v: 'rejected' as const, label: 'Rejected' },
  { v: 'closed' as const, label: 'Closed' },
  { v: 'error' as const, label: 'Error' },
];

export default async function SessionsPage({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const filter = STATES.find((s) => s.v === sp.state)?.v;
  const rows = await listSessions({ state: filter, limit: 200 });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every conversation Nexus has tracked.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {STATES.map((s) => {
          const href = s.v ? `/sessions?state=${s.v}` : '/sessions';
          const active = sp.state === s.v || (!sp.state && !s.v);
          return (
            <Link
              key={s.label}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {s.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          Icon={MessagesSquare}
          title="No sessions match this filter"
          description="Try a broader filter, or wait for new interactions to land."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Contact</th>
                <th className="px-4 py-2 text-left font-medium">State</th>
                <th className="px-4 py-2 text-left font-medium">Interactions</th>
                <th className="px-4 py-2 text-left font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer transition hover:bg-accent/40"
                >
                  <td className="px-4 py-2">
                    <Link href={`/sessions/${r.id}`} className="font-medium hover:underline">
                      {r.contactName ?? <span className="text-muted-foreground">(no contact)</span>}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <StateBadge state={r.state} />
                  </td>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">
                    {r.interactionCount}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {formatRelative(r.lastActivityAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
