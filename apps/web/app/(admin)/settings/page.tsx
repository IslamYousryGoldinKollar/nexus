import { AdminPlaceholder } from '@/components/admin-placeholder';

export default function SettingsPage() {
  return (
    <AdminPlaceholder
      title="Settings"
      subtitle="System tunables + mobile device pairing."
      items={[
        'Pair new Android device (generates QR with short-lived token)',
        'List of paired devices + revoke',
        'Notification preferences (per-event FCM / Telegram / email)',
        'Session cooldown override per contact',
        'Kill-switch numbers for phone recording',
      ]}
      phase={7}
    />
  );
}
