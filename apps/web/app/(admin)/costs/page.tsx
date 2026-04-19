import { CircleDollarSign } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { formatUsd } from '@/components/ui/format';
import { loadCostsLast30Days } from '@/lib/queries/costs-rollup';

export const dynamic = 'force-dynamic';

export default async function CostsPage() {
  const rows = await loadCostsLast30Days();

  // Pivot rows into a per-day matrix.
  const days = Array.from(new Set(rows.map((r) => r.day))).sort().reverse();
  const services = Array.from(new Set(rows.map((r) => r.service))).sort();
  const matrix = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!matrix.has(r.day)) matrix.set(r.day, new Map());
    matrix.get(r.day)!.set(r.service, r.usd);
  }

  const totalsByService = new Map<string, number>();
  let grandTotal = 0;
  for (const r of rows) {
    totalsByService.set(r.service, (totalsByService.get(r.service) ?? 0) + r.usd);
    grandTotal += r.usd;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Costs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Spend per service over the last 30 days.
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            30-day total
          </div>
          <div className="text-2xl font-semibold tabular-nums">{formatUsd(grandTotal)}</div>
        </div>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          Icon={CircleDollarSign}
          title="No spend recorded"
          description="Cost events will appear here as Whisper, Claude, AssemblyAI, and other services are billed."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Day</th>
                {services.map((s) => (
                  <th key={s} className="px-4 py-2 text-right font-medium">
                    {s}
                  </th>
                ))}
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {days.map((d) => {
                const dayTotal = services.reduce(
                  (sum, s) => sum + (matrix.get(d)?.get(s) ?? 0),
                  0,
                );
                return (
                  <tr key={d}>
                    <td className="px-4 py-2 text-muted-foreground">{d}</td>
                    {services.map((s) => (
                      <td key={s} className="px-4 py-2 text-right tabular-nums">
                        {matrix.get(d)?.get(s) ? formatUsd(matrix.get(d)!.get(s)!) : '—'}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      {formatUsd(dayTotal)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t border-border bg-muted/20 text-xs">
              <tr>
                <td className="px-4 py-2 font-medium">30-day total</td>
                {services.map((s) => (
                  <td key={s} className="px-4 py-2 text-right font-medium tabular-nums">
                    {formatUsd(totalsByService.get(s) ?? 0)}
                  </td>
                ))}
                <td className="px-4 py-2 text-right font-semibold tabular-nums">
                  {formatUsd(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
