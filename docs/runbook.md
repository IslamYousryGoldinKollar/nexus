# Nexus — Runbook

> How to respond when things break. Every playbook should read in under 60 seconds at 3am.

## Diagnostic entry points

| Symptom | First place to look |
|---|---|
| "Nothing is happening" | `/api/health` (per-service status) → Inngest dashboard (Cloud → Functions → recent runs) |
| Approval queue empty when there should be items | Sessions admin page filtered to `awaiting_approval` |
| Telegram not pinging me | Daily digest output (yesterday's `🚨` line tells you what tripped) |
| Costs spike | `/costs` page → 30-day-by-service pivot |
| Webhook signature failures | Axiom: `level:warn event:*.signature.invalid` |
| Reasoning stuck on a session | Inngest → `session-reason` runs → look for `state:error` → `/sessions/:id` to inspect |

## Common playbooks

### 1. Replay a stuck session

Symptoms: a session is `awaiting_approval` but no proposals shown, OR session stays `aggregating` past cooldown.

```
1. /sessions/:id → confirm interactions are present and last_activity_at is past cooldown
2. Inngest dashboard → search by sessionId in event payloads
3. If no `session.reasoning.requested` run found:
     a. Manually emit via `/api/admin/replay/:sessionId` (Phase 4 endpoint, TODO Phase 11+)
     b. OR send the event from Inngest UI → "Send event" → name=nexus/session.reasoning.requested
4. If a run found but errored: read the step.run failure, then re-run from the dashboard
```

### 2. Rotate a leaked webhook secret

Symptoms: secret was committed, posted publicly, or compromised.

```
WhatsApp:
  1. Meta dashboard → WhatsApp → Configuration → reset App Secret
  2. Update WHATSAPP_APP_SECRET in Vercel env (production + preview)
  3. Re-deploy (env-only re-deploy is enough)

Telegram:
  1. Generate new secret (any 32+ random chars)
  2. Update TELEGRAM_WEBHOOK_SECRET in Vercel env
  3. Re-register webhook:
       curl https://api.telegram.org/bot$BOT_TOKEN/setWebhook \
         -d "url=https://nexus.goldinkollar.com/api/ingest/telegram" \
         -d "secret_token=NEW_SECRET"

Phone uploads (PHONE_INGEST_API_KEYS, comma-list):
  1. Add a new key to the comma list (don't remove the old yet)
  2. Update Android app via remote-config OR re-pair the device with new key
  3. Once you confirm new key works, remove old key from the list

Teams extension (TEAMS_INGEST_API_KEY):
  1. Set new key in Vercel env
  2. Open Chrome extension options → paste new key → Save
```

### 3. Cost runaway

Symptoms: digest emoji is `⚠️` or `🛑`, or `/costs` shows daily spike.

```
1. Identify offender: /costs → top of the rollup table
2. Decide intent:
     - Legitimate burst (busy day) → raise budget env var (e.g., ANTHROPIC_MONTHLY_BUDGET_USD)
     - Loop / bug → flip the budget to a low number to circuit-break, then debug:
        * Anthropic: too many sessions hitting reasoning → check session-cooldown debounce in Inngest
        * Whisper: re-transcription loop → check for missing `findTranscriptByAttachment` short-circuit
3. After fix, restore budget. Cost events live forever; you can audit in supabase via:
     select date_trunc('hour', occurred_at), service, sum(cost_usd)
     from cost_events
     where occurred_at > now() - interval '24 hours'
     group by 1, 2 order by 1 desc, 3 desc;
```

### 4. Inngest backlog

Symptoms: events piling up, runs slow.

```
1. Inngest dashboard → Functions → check concurrency settings on the slow one
2. Common causes:
     - resolveAndAttach with `concurrency.limit:8` is bottlenecked on a slow upstream (R2/Anthropic)
     - transcribeAttachment hitting Whisper rate-limit → drop concurrency or wait
3. Pause the function from the Inngest UI if a flood is causing damage; events queue up safely
4. Resume when issue is fixed; Inngest replays in order
```

### 5. Magic-link sign-in not arriving

Symptoms: admin types email, hits Send, never gets the email.

```
1. /api/health → check `resend: configured`
2. Resend dashboard → Emails → look for the send by recipient
3. If `resend.skip_not_allowlisted` in logs (Axiom) → email isn't on ADMIN_ALLOWED_EMAILS
4. If 4xx from Resend: from-domain not verified or daily quota hit
5. Quick fix: temporarily set ADMIN_ALLOWED_EMAILS to include a known-good address (e.g. gmail) and re-try
```

### 6. Pending identifier flood

Symptoms: `/pending-identifiers` keeps growing.

```
1. Determine if it's:
     a. Legitimate new contacts → bulk-link via /pending-identifiers actions
     b. Spam (random WA numbers) → ignore in batch
2. If consistently noisy, flip IDENTITY_LEARNING_MODE=false in Vercel env to auto-create.
   You can re-enable later when you want manual gating again.
```

### 7. Injaz sync failure

Symptoms: approved tasks stay `approved` (not `synced`), `approved_tasks.syncError` populated.

```
1. /sessions/:id of any approved session → check approved_tasks.syncError text
2. 4xx (client error) → the task body is invalid for Injaz; admin must edit + re-approve
3. 5xx (server error) → wait for Inngest retries (3 attempts, exp backoff)
4. Permanent: re-trigger by emitting nexus/injaz.sync.requested with proposedTaskId from Inngest UI
```

### 8. Budget circuit breaker triggered

Symptoms: operations failing with "budget exceeded" status, cost notifications at 80% or 100%.

```
1. Check /costs page for current spend vs budget per service
2. If 80% warning (⚠️): legitimate spike → raise budget env var (e.g., ANTHROPIC_MONTHLY_BUDGET_USD)
3. If 100% hard stop (🛑): operations blocked → immediate action required:
   a. If loop/bug: flip budget to $1 to stop bleeding, then debug
   b. If legitimate need: raise budget env var to restore operations
4. Budget override for emergencies: temporarily set BUDGET_OVERRIDE=true to bypass checks (use with extreme caution)
5. After fix, restore budget. Cost events are auditable via:
   select date_trunc('hour', occurred_at), service, sum(cost_usd)
   from cost_events
   where occurred_at > now() - interval '24 hours'
   group by 1, 2 order by 1 desc, 3 desc;
```

### 9. Telegram fallback not sending

Symptoms: FCM push not received, Telegram fallback not arriving after delay.

```
1. Check notification record in DB: notifications table for fallback_due_at timestamp
2. Verify TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_IDS are set in Vercel env
3. Check Inngest dashboard for telegram-fallback function runs
4. If fallback_due_at is in future: wait for delay (30m for proposals, 10m for identifiers)
5. If delivered_channels includes 'telegram': fallback was sent, check Telegram delivery
6. Test bot directly: curl https://api.telegram.org/bot$TOKEN/getMe
```

## Observability surfaces

| Surface | What lives there |
|---|---|
| Vercel logs | Real-time stdout (JSON-line per event) |
| Axiom dataset `nexus` | Structured logs, queryable. Auto-shipped from `log.*()` |
| Sentry | Errors only (level >= error from `log.*()`); requires `@sentry/node` installed |
| Inngest dashboard | Function runs, retries, durations, event payloads |
| Supabase Studio | DB rows for ad-hoc inspection |
| `/dashboard` | Admin-facing live KPIs |
| Telegram daily digest | Push summary at 09:00 UTC |

## Backups

- **Postgres**: Supabase nightly snapshot (free tier = 7 days; upgrade to pro for 30 day PITR)
- **R2**: lifecycle rules per channel prefix; raw audio is the system-of-record for transcripts
- **Reasoning context bundles + raw responses**: stored in `reasoning_runs.context_bundle` + `raw_response` jsonb so we can replay any reasoning run if Claude returns garbage

## Emergency stop

If everything is on fire and you want to stop the world:

```
1. Vercel: Pause the project (Settings → Pause). Webhooks will 503; senders will retry.
2. Inngest: pause every function in the dashboard.
3. Telegram bot: deleteWebhook to prevent updates piling up.
4. Reach for backups; everything we ingest is dedupable so re-running once you're back is safe.
```
