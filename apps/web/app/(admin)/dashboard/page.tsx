import {
  CircleDollarSign,
  Inbox,
  Link2,
  MessagesSquare,
  SquareCheckBig,
  Activity,
} from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelative, formatUsd } from '@/components/ui/format';
import { KpiCard } from '@/components/ui/kpi-card';
import { StateBadge } from '@/components/ui/state-badge';
import { loadDashboardSnapshot } from '@/lib/queries/dashboard';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const snap = await loadDashboardSnapshot();
  const totalSpend30d = snap.spend30d.reduce((s, r) => s + r.usd, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What&apos;s flowing through Nexus right now.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          label="Awaiting"
          value={snap.awaitingApproval}
          hint="proposals to review"
          href="/approvals"
          Icon={SquareCheckBig}
          tone={snap.awaitingApproval > 0 ? 'warning' : 'default'}
        />
        <KpiCard
          label="Open sessions"
          value={snap.openSessions}
          hint="aggregating"
          href="/sessions?state=open"
          Icon={MessagesSquare}
        />
        <KpiCard
          label="Pending IDs"
          value={snap.pendingIdentifiers}
          hint="link to a contact"
          href="/pending-identifiers"
          Icon={Link2}
          tone={snap.pendingIdentifiers > 0 ? 'warning' : 'default'}
        />
        <KpiCard
          label="Ingested 24h"
          value={snap.ingest24h}
          hint="webhooks"
          Icon={Inbox}
        />
        <KpiCard
          label="Tasks 24h"
          value={snap.proposedTasks24h}
          hint="proposed"
          Icon={Activity}
        />
        <KpiCard
          label="Spend 30d"
          value={formatUsd(totalSpend30d)}
          hint="all services"
          href="/costs"
          Icon={CircleDollarSign}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between px-5 py-3">
            <h2 className="text-sm font-medium">Recent sessions</h2>
            <Link
              href="/sessions"
              className="text-xs text-muted-foreground transition hover:text-foreground"
            >
              View all →
            </Link>
          </div>
          {snap.recentSessions.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState
                Icon={MessagesSquare}
                title="No sessions yet"
                description="Sessions will appear once webhooks start landing messages."
              />
            </div>
          ) : (
            <div className="divide-y divide-border border-t border-border">
              {snap.recentSessions.map((s) => (
                <Link
                  key={s.id}
                  href={`/sessions/${s.id}`}
                  className="flex items-center justify-between px-5 py-3 text-sm transition hover:bg-accent/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {s.contactName ?? '(no contact yet)'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.interactionCount} interaction{s.interactionCount === 1 ? '' : 's'} ·{' '}
                      {formatRelative(s.lastActivityAt)}
                    </div>
                  </div>
                  <StateBadge state={s.state} />
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card">
          <div className="px-5 py-3">
            <h2 className="text-sm font-medium">Spend by service · 30d</h2>
          </div>
          {snap.spend30d.length === 0 ? (
            <div className="px-5 pb-5 text-xs text-muted-foreground">No spend recorded yet.</div>
          ) : (
            <ul className="divide-y divide-border border-t border-border">
              {snap.spend30d
                .sort((a, b) => b.usd - a.usd)
                .map((s) => (
                  <li key={s.service} className="flex items-center justify-between px-5 py-2.5 text-sm">
                    <span className="text-muted-foreground">{s.service}</span>
                    <span className="font-medium tabular-nums">{formatUsd(s.usd)}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
