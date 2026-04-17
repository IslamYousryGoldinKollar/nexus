import { AdminPlaceholder } from '@/components/admin-placeholder';

export default function CostsPage() {
  return (
    <AdminPlaceholder
      title="Costs"
      subtitle="Every LLM call, every transcription. Circuit breakers trip at 100% of monthly budget."
      items={[
        'This month spend by service (Anthropic, Whisper, AssemblyAI, R2)',
        'Budget bars with 80% warning and 100% circuit-break',
        'Per-session top spenders',
        'Raw cost_events ledger (CSV export)',
      ]}
      phase={5}
    />
  );
}
