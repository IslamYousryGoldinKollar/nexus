import { AdminPlaceholder } from '@/components/admin-placeholder';

export default function SessionsPage() {
  return (
    <AdminPlaceholder
      title="Sessions"
      subtitle="Bounded conversation contexts. Each is a staging area before reasoning."
      items={[
        'Filter by state (open, aggregating, reasoning, awaiting approval, …)',
        'Filter by contact / account / channel',
        'Drill-in: timeline of interactions with attachments inline',
        'Manual actions: trigger reasoning now, close, split, merge',
      ]}
      phase={5}
    />
  );
}
