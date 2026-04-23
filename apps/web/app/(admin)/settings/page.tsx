import { Construction } from 'lucide-react';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Settings page for Phase 5 is read-only — it shows which integrations
 * are configured (env-based) so an admin can confirm secrets landed
 * without dropping into Vercel. OAuth-flow buttons (Gmail connect,
 * Google Drive root pick) ship in Phase 5+.
 */
export default function SettingsPage() {
  let serverEnv;
  try {
    serverEnv = env();
  } catch (err) {
    console.error('Failed to parse server env:', err);
    serverEnv = {} as ReturnType<typeof env>;
  }

  const checks = [
    { key: 'WhatsApp', ok: !!serverEnv.WHATSAPP_ACCESS_TOKEN, hint: 'WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN' },
    { key: 'Telegram', ok: !!serverEnv.TELEGRAM_BOT_TOKEN, hint: 'TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET' },
    { key: 'Gmail (Pub/Sub)', ok: !!serverEnv.GOOGLE_CLIENT_ID, hint: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN' },
    { key: 'Phone uploads', ok: !!serverEnv.PHONE_INGEST_API_KEYS, hint: 'PHONE_INGEST_API_KEYS (comma list)' },
    { key: 'MS Teams', ok: !!serverEnv.TEAMS_INGEST_API_KEY, hint: 'TEAMS_INGEST_API_KEY' },
    { key: 'Cloudflare R2', ok: !!serverEnv.R2_ACCESS_KEY_ID, hint: 'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET' },
    { key: 'Anthropic', ok: !!serverEnv.ANTHROPIC_API_KEY, hint: 'ANTHROPIC_API_KEY' },
    { key: 'OpenAI Whisper', ok: !!serverEnv.OPENAI_API_KEY, hint: 'OPENAI_API_KEY' },
    { key: 'AssemblyAI', ok: !!serverEnv.ASSEMBLYAI_API_KEY, hint: 'ASSEMBLYAI_API_KEY' },
    { key: 'Resend (magic links)', ok: !!serverEnv.RESEND_API_KEY, hint: 'RESEND_API_KEY, RESEND_FROM_EMAIL' },
    { key: 'Inngest', ok: !!serverEnv.INNGEST_EVENT_KEY, hint: 'INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY' },
    { key: 'Injaz sync', ok: !!serverEnv.INJAZ_API_KEY, hint: 'INJAZ_API_KEY, INJAZ_MCP_URL' },
    { key: 'FCM (Android push)', ok: !!serverEnv.FCM_PROJECT_ID, hint: 'FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY' },
    { key: 'Axiom (logs)', ok: !!serverEnv.AXIOM_TOKEN, hint: 'AXIOM_TOKEN, AXIOM_DATASET' },
    { key: 'Sentry', ok: !!serverEnv.SENTRY_DSN, hint: 'SENTRY_DSN' },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Integration status. Configure via env vars in Vercel + Supabase Vault.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <Construction className="size-3.5" /> read-only · OAuth buttons in Phase 5+
        </span>
      </header>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ul className="divide-y divide-border">
          {checks.map((c) => (
            <li key={c.key} className="flex items-start justify-between gap-4 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block size-1.5 rounded-full ${
                      c.ok ? 'bg-emerald-500' : 'bg-zinc-400/60'
                    }`}
                  />
                  <span className="text-sm font-medium">{c.key}</span>
                </div>
                <p className="ml-3.5 mt-1 text-xs text-muted-foreground">{c.hint}</p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${
                  c.ok
                    ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {c.ok ? 'configured' : 'not set'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
