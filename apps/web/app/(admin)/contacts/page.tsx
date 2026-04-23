import { Contact } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelative } from '@/components/ui/format';
import { listContacts } from '@/lib/queries/contacts-list';
import ContactPrivacyControls from './contact-privacy-controls';

export const dynamic = 'force-dynamic';

export default async function ContactsPage() {
  const rows = await listContacts(200);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone Nexus has identified across channels.
        </p>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          Icon={Contact}
          title="No contacts yet"
          description="Contacts are auto-created from incoming messages or linked from the pending-identifiers queue."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Identifiers</th>
                <th className="px-4 py-2 text-center font-medium">Transcribe</th>
                <th className="px-4 py-2 text-center font-medium">Action</th>
                <th className="px-4 py-2 text-right font-medium">Sessions</th>
                <th className="px-4 py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ contact, identifiers, sessionCount }) => (
                <tr key={contact.id}>
                  <td className="px-4 py-2 font-medium">{contact.displayName}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {identifiers.slice(0, 3).map((i) => (
                        <span
                          key={i.id}
                          className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          <span className="text-muted-foreground">{i.kind}=</span>
                          {i.value}
                        </span>
                      ))}
                      {identifiers.length > 3 && (
                        <span className="text-xs text-muted-foreground">
                          +{identifiers.length - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <ContactPrivacyControls
                      contactId={contact.id}
                      field="allowTranscription"
                      defaultValue={contact.allowTranscription ?? true}
                    />
                  </td>
                  <td className="px-4 py-2 text-center">
                    <ContactPrivacyControls
                      contactId={contact.id}
                      field="allowAction"
                      defaultValue={contact.allowAction ?? true}
                    />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {sessionCount}
                  </td>
                  <td className="px-4 py-2 text-right text-muted-foreground">
                    {formatRelative(contact.updatedAt)}
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
