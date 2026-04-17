import { AdminPlaceholder } from '@/components/admin-placeholder';

export default function ContactsPage() {
  return (
    <AdminPlaceholder
      title="Contacts"
      subtitle="People we communicate with. One contact can have many identifiers."
      items={[
        'Search + filter by account',
        'Detail: identifiers (add/verify/remove)',
        'Linked sessions timeline',
        'Merge contacts (human decision only — never auto)',
      ]}
      phase={2}
    />
  );
}
