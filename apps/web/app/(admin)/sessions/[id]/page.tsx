import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Mic, MessageSquare, Phone, Mail, Video } from 'lucide-react';
import { formatRelative } from '@/components/ui/format';
import { StateBadge } from '@/components/ui/state-badge';
import { getSessionDetail } from '@/lib/queries/sessions-list';

export const dynamic = 'force-dynamic';

const CHANNEL_ICON = {
  whatsapp: MessageSquare,
  telegram: MessageSquare,
  gmail: Mail,
  phone: Phone,
  teams: Video,
} as const;

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await getSessionDetail(id);
  if (!ctx) notFound();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-start gap-4">
        <Link
          href="/sessions"
          className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Back
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">
              {ctx.contact?.displayName ?? '(no contact)'}
            </h1>
            <StateBadge state={ctx.session.state} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Opened {formatRelative(ctx.session.openedAt)} · last activity{' '}
            {formatRelative(ctx.session.lastActivityAt)}
            {ctx.account && <> · account {ctx.account.name}</>}
          </p>
        </div>
      </header>

      {ctx.identifiers.length > 0 && (
        <div className="rounded-lg border border-border bg-card px-5 py-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Identifiers
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ctx.identifiers.map((i) => (
              <span
                key={i.id}
                className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs"
              >
                <span className="text-muted-foreground">{i.kind}=</span>
                {i.value}
              </span>
            ))}
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium">Interactions ({ctx.interactions.length})</h2>
        {ctx.interactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No interactions yet.</p>
        ) : (
          <div className="space-y-3">
            {ctx.interactions.map(({ interaction, attachments, transcripts }) => {
              const Icon = CHANNEL_ICON[interaction.channel as keyof typeof CHANNEL_ICON] ?? MessageSquare;
              return (
                <div
                  key={interaction.id}
                  className="rounded-md border border-border bg-card p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Icon className="size-3.5" />
                      <span className="capitalize">{interaction.channel}</span>
                      <span>·</span>
                      <span>{interaction.contentType}</span>
                      <span>·</span>
                      <span>{interaction.direction}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatRelative(interaction.occurredAt)}
                    </span>
                  </div>
                  {interaction.text && (
                    <p className="mt-2 whitespace-pre-wrap text-sm">{interaction.text}</p>
                  )}
                  {attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                      {attachments.map((a) => (
                        <span
                          key={a.id}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5"
                        >
                          <Mic className="size-3" />
                          {a.mimeType}
                          {a.sizeBytes != null && <> · {Math.round(a.sizeBytes / 1024)} KB</>}
                        </span>
                      ))}
                    </div>
                  )}
                  {transcripts.length > 0 && (
                    <div className="mt-3 rounded-md border-l-2 border-primary/40 bg-muted/30 px-3 py-2">
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        Transcript ({transcripts[0]?.provider})
                      </div>
                      <p className="whitespace-pre-wrap text-xs">{transcripts[0]?.text}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
