/**
 * Environment contract for the WA bridge.
 *
 * Separated from runtime code so a misconfigured pod fails loudly at boot
 * instead of silently swallowing events. All secrets come from the host
 * (Fly/Railway/Docker). No fallbacks in production.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export const env = {
  // --- Forwarding target ---
  nexusApiUrl: required('WA_BRIDGE_NEXUS_URL').replace(/\/$/, ''),
  hmacSecret: required('WA_BRIDGE_HMAC_SECRET'),

  // --- Supabase Storage (for media + auth state snapshots) ---
  supabaseUrl: required('SUPABASE_URL').replace(/\/$/, ''),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  storageBucket: optional('SUPABASE_STORAGE_BUCKET', 'nexus-attachments'),

  // --- Pairing ---
  //   If set, we use the 8-char pairing code flow (works with any
  //   WhatsApp install). Otherwise a QR code is printed to stdout.
  pairPhoneNumber: optional('WA_BRIDGE_PAIR_NUMBER'),

  // --- Local disk (ephemeral, just hot cache for Baileys) ---
  authDir: optional('WA_BRIDGE_AUTH_DIR', './auth'),

  // --- Behavior ---
  logLevel: optional('LOG_LEVEL', 'info'),
  dryRun: optional('WA_BRIDGE_DRY_RUN') === '1',
};
