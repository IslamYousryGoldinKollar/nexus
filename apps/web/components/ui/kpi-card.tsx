import { type LucideIcon } from 'lucide-react';

/**
 * Compact metric card. Used on the dashboard.
 *
 * Pure server component — receives a pre-computed `value` and renders.
 * No client interactivity needed for KPIs.
 */

interface Props {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  Icon?: LucideIcon;
  tone?: 'default' | 'warning' | 'success';
}

const TONE: Record<NonNullable<Props['tone']>, string> = {
  default: 'text-foreground',
  warning: 'text-amber-500',
  success: 'text-emerald-500',
};

export function KpiCard({ label, value, hint, href, Icon, tone = 'default' }: Props) {
  const content = (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card p-4 transition hover:border-primary/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
      </div>
      <div className={`mt-2 text-2xl font-semibold tracking-tight ${TONE[tone]}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
  if (href) {
    return (
      <a href={href} className="block h-full">
        {content}
      </a>
    );
  }
  return content;
}
