import { AdminPlaceholder } from '@/components/admin-placeholder';

export default function ApprovalsPage() {
  return (
    <AdminPlaceholder
      title="Approvals"
      subtitle="Proposed tasks from Claude, waiting for you to approve, edit, or reject."
      items={[
        'Task title, description, assignee, priority, due date — editable inline',
        'Rationale (read-only)',
        'Evidence list with expandable quotes + audio playback',
        'Approve / Edit / Reject buttons (biometric gate on mobile equivalent)',
      ]}
      phase={5}
    />
  );
}
