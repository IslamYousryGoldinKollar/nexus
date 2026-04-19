import { Link2, MailX, UserPlus, X } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelative } from '@/components/ui/format';
import { listContacts } from '@/lib/queries/contacts-list';
import { listPendingIdentifiers } from '@/lib/queries/pending-ids';
import {
  createContactFromPending,
  ignorePending,
  linkToContact,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function PendingIdentifiersPage() {
  const [pending, contactRows] = await Promise.all([
    listPendingIdentifiers(),
    listContacts(500),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pending identifiers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Identifiers Nexus saw but couldn&apos;t auto-link to a known contact.
          Resolve each one before reasoning will run.
        </p>
      </header>

      {pending.length === 0 ? (
        <EmptyState
          Icon={Link2}
          title="Nothing pending"
          description="All identifiers have been resolved. New ones land here when learning mode is on."
        />
      ) : (
        <div className="space-y-4">
          {pending.map((p) => (
            <div key={p.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-mono text-sm">
                    <span className="text-muted-foreground">{p.kind}=</span>
                    {p.value}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    First seen {formatRelative(p.createdAt)}
                  </p>
                </div>
                <form action={ignorePending}>
                  <input type="hidden" name="pendingId" value={p.id} />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
                    title="Ignore — won't be suggested again"
                  >
                    <MailX className="size-3.5" /> Ignore
                  </button>
                </form>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {/* Link to existing contact */}
                <form
                  action={linkToContact}
                  className="space-y-2 rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <Link2 className="size-3.5" />
                    Link to existing
                  </div>
                  <input type="hidden" name="pendingId" value={p.id} />
                  <select
                    name="contactId"
                    required
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
                  >
                    <option value="">— pick a contact —</option>
                    {contactRows.map((c) => (
                      <option key={c.contact.id} value={c.contact.id}>
                        {c.contact.displayName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90"
                  >
                    Link
                  </button>
                </form>

                {/* Create new contact */}
                <form
                  action={createContactFromPending}
                  className="space-y-2 rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <UserPlus className="size-3.5" />
                    Create new contact
                  </div>
                  <input type="hidden" name="pendingId" value={p.id} />
                  <input
                    name="displayName"
                    required
                    placeholder="Display name"
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
                  />
                  <button
                    type="submit"
                    className="w-full rounded-md border border-primary px-2 py-1.5 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-foreground"
                  >
                    Create + link
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* X icon kept as type-import sentinel */}
      <span className="sr-only">
        <X />
      </span>
    </div>
  );
}
