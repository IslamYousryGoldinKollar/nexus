import Link from 'next/link';
import { Inbox, MessageSquare } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelative, formatUsd } from '@/components/ui/format';
import { loadAwaitingApprovals } from '@/lib/queries/approvals';
import { TaskCard } from './task-card';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const cards = await loadAwaitingApprovals();

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the tasks Nexus proposed. Approve, edit, or reject each one.
          </p>
        </div>
        <span className="rounded-full border border-border bg-card px-3 py-1 text-xs">
          {cards.length} awaiting
        </span>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          Icon={Inbox}
          title="Inbox zero"
          description="No proposals are awaiting review. New ones land here as Nexus reasons over silent sessions."
        />
      ) : (
        <div className="space-y-6">
          {cards.map(({ session, contactName, reasoningRun, tasks }) => (
            <article
              key={session.id}
              className="overflow-hidden rounded-lg border border-border bg-card"
            >
              <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/sessions/${session.id}`}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {contactName ?? '(no contact)'}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Last activity {formatRelative(session.lastActivityAt)}
                    {reasoningRun && (
                      <>
                        {' · '}
                        Claude {formatUsd(Number(reasoningRun.costUsd))} · {reasoningRun.tokensIn ?? 0} in / {reasoningRun.tokensOut ?? 0} out
                      </>
                    )}
                  </p>
                </div>
                <Link
                  href={`/sessions/${session.id}`}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground"
                >
                  <MessageSquare className="size-3.5" />
                  Open session
                </Link>
              </header>

              <div className="space-y-3 p-5">
                {tasks.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
