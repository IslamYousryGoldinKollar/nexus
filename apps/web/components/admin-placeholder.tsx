import { Construction } from 'lucide-react';

/**
 * Scaffolding placeholder for admin pages that don't have real data yet.
 * Each page uses this to document what it will look like by the phase noted.
 */
interface Props {
  title: string;
  subtitle: string;
  items: readonly string[];
  phase: number;
}

export function AdminPlaceholder({ title, subtitle, items, phase }: Props) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 py-8">
      <div className="flex items-start justify-between gap-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <Construction className="size-3.5" />
          ships in phase {phase}
        </span>
      </div>
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
          Planned capabilities
        </div>
        <ul className="space-y-2 text-sm">
          {items.map((item) => (
            <li key={item} className="flex items-start gap-3">
              <span className="mt-2 inline-block size-1 shrink-0 rounded-full bg-primary" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
