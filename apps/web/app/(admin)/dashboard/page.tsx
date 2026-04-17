import { AdminPlaceholder } from '@/components/admin-placeholder';

export default function DashboardPage() {
  return (
    <AdminPlaceholder
      title="Dashboard"
      subtitle="Your daily cockpit — proposals, pending identifiers, errors, spend."
      items={[
        'Badge counts (approvals, pending IDs, errors)',
        'Recent sessions feed',
        'This-month spend vs budget',
        'Quick action: trigger reasoning on a session',
      ]}
      phase={5}
    />
  );
}
