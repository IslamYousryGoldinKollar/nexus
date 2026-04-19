import { type LucideIcon } from 'lucide-react';

/**
 * Friendly empty-state for tables and queues. Better than a blank table.
 */

interface Props {
  Icon: LucideIcon;
  title: string;
  description: string;
}

export function EmptyState({ Icon, title, description }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card p-12 text-center">
      <Icon className="size-8 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
