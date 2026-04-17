import { z } from 'zod';

/**
 * Server-side environment schema. Parsed once at module load —
 * if any required var is missing the process exits with a clear error.
 *
 * Do NOT import this from browser code. For client-exposed vars use
 * NEXT_PUBLIC_* and a separate schema.
 */

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .default('false');

export const serverEnvSchema = z.object({
  // Core
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: z.string().url(),
  ADMIN_ALLOWED_EMAILS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),

  // Database
  DATABASE_URL: z.string().url(),
  DATABASE_URL_UNPOOLED: z.string().url().optional(),

  // Redis
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // R2
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('nexus-attachments'),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),

  // LLM
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5-20250929'),
  ANTHROPIC_MONTHLY_BUDGET_USD: z.coerce.number().default(200),

  // Transcription
  OPENAI_API_KEY: z.string().optional(),
  ASSEMBLYAI_API_KEY: z.string().optional(),
  WHISPER_MONTHLY_BUDGET_USD: z.coerce.number().default(100),

  // Inngest
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // WhatsApp
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_ADMIN_IDS: z.string().default(''),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),

  // Gmail
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GMAIL_WATCHED_LABELS: z.string().default('INBOX'),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().optional(),
  GOOGLE_PUBSUB_VERIFICATION_TOKEN: z.string().optional(),

  // MS Teams
  TEAMS_INGEST_API_KEY: z.string().optional(),
  MS_TENANT_ID: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),

  // Injaz
  INJAZ_API_BASE: z.string().url().default('https://injaz.goldinkollar.com/api'),
  INJAZ_MCP_URL: z.string().url().optional(),
  INJAZ_API_KEY: z.string().optional(),

  // Phone recorder
  PHONE_INGEST_API_KEYS: z.string().default(''),
  PHONE_INGEST_HMAC_SECRET: z.string().optional(),

  // FCM
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),

  // Auth
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().default('nexus@goldinkollar.com'),
  AUTH_SECRET: z.string().min(16).optional(),

  // Mobile pairing
  DEVICE_PAIRING_SECRET: z.string().min(16).optional(),
  DEVICE_JWT_SECRET: z.string().min(16).optional(),

  // Observability
  AXIOM_TOKEN: z.string().optional(),
  AXIOM_DATASET: z.string().default('nexus'),
  SENTRY_DSN: z.string().url().optional(),

  // Feature flags
  SESSION_COOLDOWN_MIN: z.coerce.number().default(120),
  SESSION_SWEEP_CRON: z.string().default('0 */2 * * *'),
  IDENTITY_LEARNING_MODE: booleanString,
  NOTIFY_FALLBACK_PROPOSAL_MIN: z.coerce.number().default(30),
  NOTIFY_FALLBACK_PENDING_ID_MIN: z.coerce.number().default(10),
  NOTIFY_FALLBACK_INJAZ_FAIL_MIN: z.coerce.number().default(60),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Parses and freezes the environment. Call once per process at startup.
 * Throws a clear aggregated error if required vars are missing.
 *
 * `raw` is `Record<string, string | undefined>` (a.k.a. the shape of
 * `process.env`) to avoid depending on `@types/node` in this package.
 */
export function parseServerEnv(
  raw: Record<string, string | undefined>,
): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return Object.freeze(result.data);
}
