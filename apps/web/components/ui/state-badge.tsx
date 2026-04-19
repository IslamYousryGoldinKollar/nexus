/**
 * State chip used in tables (sessions, proposals).
 *
 * Pure presentational. Color is mapped from state name; unknown states
 * fall back to neutral.
 */

const TONE: Record<string, string> = {
  open: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20',
  aggregating: 'bg-sky-500/10 text-sky-600 ring-sky-500/20',
  reasoning: 'bg-violet-500/10 text-violet-600 ring-violet-500/20',
  awaiting_approval: 'bg-amber-500/10 text-amber-600 ring-amber-500/20',
  approved: 'bg-emerald-600/10 text-emerald-700 ring-emerald-600/20',
  rejected: 'bg-red-500/10 text-red-600 ring-red-500/20',
  synced: 'bg-blue-500/10 text-blue-600 ring-blue-500/20',
  closed: 'bg-zinc-500/10 text-zinc-600 ring-zinc-500/20',
  error: 'bg-red-600/10 text-red-700 ring-red-600/20',
  proposed: 'bg-indigo-500/10 text-indigo-600 ring-indigo-500/20',
  edited: 'bg-purple-500/10 text-purple-600 ring-purple-500/20',
  pending: 'bg-amber-500/10 text-amber-600 ring-amber-500/20',
  linked: 'bg-emerald-600/10 text-emerald-700 ring-emerald-600/20',
  ignored: 'bg-zinc-500/10 text-zinc-600 ring-zinc-500/20',
};

export function StateBadge({ state }: { state: string }) {
  const tone = TONE[state] ?? 'bg-muted text-muted-foreground ring-border';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${tone}`}
    >
      {state.replaceAll('_', ' ')}
    </span>
  );
}
