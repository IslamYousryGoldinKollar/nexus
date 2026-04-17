import { AdminPlaceholder } from '@/components/admin-placeholder';

export default function PendingIdentifiersPage() {
  return (
    <AdminPlaceholder
      title="Pending Identifiers"
      subtitle="Unknown phones / emails / handles that Nexus saw but cannot resolve yet."
      items={[
        'Card per identifier: first-message preview, suggested match + confidence',
        'Link to existing contact / Create new / Ignore',
        'Learning mode: first 30 days ALL non-exact matches land here',
        'Auto-linking threshold configurable after learning period',
      ]}
      phase={2}
    />
  );
}
