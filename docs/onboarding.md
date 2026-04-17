# Nexus — Onboarding Playbook

Every action you (Islam) need to take to unblock Phase 1+, with the exact clicks and URLs. Follow top-to-bottom.

---

## Table of contents

1. [Supabase — 2-minute DB password reset](#1-supabase--2-minute-db-password-reset)
2. [Vercel — deploy the web app](#2-vercel--deploy-the-web-app)
3. [GitHub — create repo + push](#3-github--create-repo--push)
4. [WhatsApp Business Cloud API](#4-whatsapp-business-cloud-api)
5. [Gmail Workspace (Pub/Sub watch)](#5-gmail-workspace-pubsub-watch)
6. [Telegram bot (fallback approval surface)](#6-telegram-bot-fallback-approval-surface)
7. [Anthropic / OpenAI / AssemblyAI — API keys](#7-anthropic--openai--assemblyai--api-keys)
8. [Inngest — durable workflows](#8-inngest--durable-workflows)
9. [Cloudflare R2 — audio storage](#9-cloudflare-r2--audio-storage)
10. [Upstash Redis — idempotency + rate-limit](#10-upstash-redis--idempotency--rate-limit)
11. [Firebase — push notifications (deferred to Phase 7)](#11-firebase--push-notifications-deferred-to-phase-7)
12. [Samsung S24 call recording — Orange/Vodafone strategy](#12-samsung-s24-call-recording--orangevodafone-strategy)

---

## 1. Supabase — 2-minute DB password reset

The Supabase project `nexus` is already provisioned (`clwvamwweevvmqyfqkzq`, region `eu-central-1`). The schema is applied (17 tables, RLS enabled). You just need to grab the connection strings.

### Steps

1. Open the connect modal: https://supabase.com/dashboard/project/clwvamwweevvmqyfqkzq?showConnect=true
2. Click **Database Settings → Reset database password**. Set a strong random password (the password manager in your browser is fine). **Copy it.**
3. Back in the Connect modal, copy these two strings:
   - **Transaction pooler** (port 6543) → this is `DATABASE_URL`
   - **Session pooler** or **Direct connection** (port 5432) → this is `DATABASE_URL_UNPOOLED`
4. Open `.env.local` at the repo root (copy from `.env.example` first if it doesn't exist) and paste both strings, replacing `[YOUR-PASSWORD]`.
5. Also copy from **Settings → API**:
   - `SUPABASE_URL` → `https://clwvamwweevvmqyfqkzq.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → the `anon` key
   - `SUPABASE_SERVICE_ROLE_KEY` → the `service_role` key (**server-only**, treat like a root password)

### Verify

```bash
pnpm --filter @nexus/web dev
# Open http://localhost:3000/api/health — should return {"status":"ok"}
```

---

## 2. Vercel — deploy the web app

I don't have a Vercel MCP, so this is a one-time CLI dance. Takes ~5 min.

### Steps

```bash
# 1. Install the CLI (once)
pnpm dlx vercel@latest --version

# 2. Link the project (from repo root)
pnpm dlx vercel@latest link --cwd apps/web
#   · Scope: your team or personal
#   · Project name: nexus-web
#   · Root: apps/web
#   · Framework: Next.js (auto-detected)

# 3. Copy every var from .env.local into Vercel dashboard
#    (Production + Preview + Development):
#    https://vercel.com/dashboard → nexus-web → Settings → Environment Variables
#    Paste each key/value from .env.local. For NEXT_PUBLIC_* keys, also set
#    "Exposed to client-side".

# 4. Deploy
pnpm dlx vercel@latest --prod --cwd apps/web
```

### Verify

```bash
# Visit the deployment URL printed by the CLI and hit /api/health
curl https://nexus-web-<hash>.vercel.app/api/health
```

---

## 3. GitHub — create repo + push

No GitHub MCP installed, so again a small manual step.

### Steps

1. Create a new **private** repo: https://github.com/new
   - Name: `nexus`
   - Owner: `goldinkollar` org (or personal — your call)
   - **Do NOT** initialise with README / .gitignore / license (we already have them)
2. Copy the SSH URL: `git@github.com:<owner>/nexus.git`
3. From repo root:

```bash
git remote add origin git@github.com:<owner>/nexus.git
git push -u origin main
```

4. After the first push, CI will run automatically. Go to the **Actions** tab to confirm the green check.

### Optional — install GitHub MCP so I can manage issues/PRs

If you want me to open PRs, comment on issues, etc., install the GitHub MCP in Windsurf:
- Windsurf → Settings → MCP Servers → **Add GitHub MCP**
- Generate a fine-grained PAT with repo scope: https://github.com/settings/tokens?type=beta
- Paste it; restart Windsurf.

Without this, you'll need to merge PRs manually; I can still push commits to branches once you give me the remote.

---

## 4. WhatsApp Business Cloud API

You have only personal WhatsApp. To ingest from WhatsApp, Nexus needs the **WhatsApp Business Cloud API** (Meta-hosted, free up to 1,000 conversations/month, then pay-per-conversation). **You do not need to replace your personal number** — you can register a new number or port your personal number once you accept the business terms.

### Pre-reqs

- A phone number that is NOT currently on WhatsApp (or you accept wiping it from personal WhatsApp).
- A Meta Business account. If you don't have one: https://business.facebook.com/overview

### Decision to make first

**Option A — New dedicated business number** (recommended)
- Pros: clean separation, keep personal WhatsApp untouched, safer
- Cons: buy a second SIM or VoIP number
- Cost: ~$5–$15/month for a virtual number (Twilio, Vonage, or local Egyptian operator)

**Option B — Migrate your personal number**
- Pros: clients message the same number
- Cons: you lose personal WhatsApp on that number permanently; everything routes through the business API
- Not reversible without re-registration

> My recommendation: **Option A.** Get a second Orange/Vodafone prepaid SIM (~50–100 EGP). Use it only for the business API. Forward WhatsApp clients to the new number gradually.

### Setup steps (once number is chosen)

1. **Create a Meta app**: https://developers.facebook.com/apps/
   - Use case → **Other** → **Business**
   - Name: `GoldinKollar Nexus`
2. **Add the WhatsApp product**: inside the app dashboard → **Add Product** → WhatsApp → **Set up**.
3. **Add the phone number**: WhatsApp → Getting Started → **Add phone number**. You'll get a 6-digit code via SMS/call to verify. Save the **phone_number_id** and **business_account_id** that appear.
4. **Generate a permanent access token** (do NOT use the 24-hour temporary one):
   - Go to **Business Settings** → **Users** → **System Users** → **Add**
   - Name: `nexus-bot`, role: Admin
   - Click the system user → **Generate token** → select your app → permissions: `whatsapp_business_messaging`, `whatsapp_business_management` → **Never expires**.
   - Copy the token → this is `WHATSAPP_ACCESS_TOKEN`.
5. **Set the webhook** (this is what Nexus listens to):
   - Under WhatsApp → Configuration → **Webhook**
   - Callback URL: `https://nexus.goldinkollar.com/api/ingest/whatsapp` (or your Vercel preview URL for testing)
   - Verify token: generate a long random string (`openssl rand -hex 32`) → this is `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and Save**
   - Subscribe to: `messages`, `message_status`, `message_template_status_update`
6. **App secret** (for signature verification): App Dashboard → **Settings** → Basic → **App Secret** (click "Show") → this is `WHATSAPP_APP_SECRET`.

### Fill in `.env.local`

```bash
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
```

### Test

Once deployed, send a WhatsApp message to your business number. The webhook at `/api/ingest/whatsapp` will log it. In Phase 1 we turn that log into a real `interactions` row.

---

## 5. Gmail Workspace (Pub/Sub watch)

Your `islam.yousry@goldinkollar.com` is a Workspace account — perfect. Gmail pushes new-message events to a Google Pub/Sub topic which we subscribe to.

### Steps

1. **Create a Google Cloud project**:
   - https://console.cloud.google.com/projectcreate
   - Name: `goldinkollar-nexus`
   - Organisation: your goldinkollar.com workspace
2. **Enable APIs** (https://console.cloud.google.com/apis/library):
   - Gmail API
   - Cloud Pub/Sub API
3. **Create a Pub/Sub topic**:
   - https://console.cloud.google.com/cloudpubsub/topic/create
   - Topic ID: `nexus-gmail-events`
   - Grant publisher role to `gmail-api-push@system.gserviceaccount.com` (this is the Gmail service agent)
4. **Create a Pub/Sub push subscription**:
   - Name: `nexus-gmail-push`
   - Delivery type: **Push**
   - Endpoint URL: `https://nexus.goldinkollar.com/api/ingest/gmail`
   - Enable authentication → Service account → create `nexus-gmail-push@goldinkollar-nexus.iam.gserviceaccount.com`
5. **OAuth 2.0 Client** for Gmail API (to authorise Nexus to read mail):
   - APIs & Services → Credentials → **Create Credentials** → OAuth client ID
   - Type: Web application
   - Authorised redirect URI: `https://nexus.goldinkollar.com/api/auth/gmail/callback`
   - Download the JSON → copy `client_id` + `client_secret`
6. **Do the OAuth dance once** (Phase 1 ships a helper page):
   - Visit `/admin/settings/connections` → **Connect Gmail** → accept scopes: `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/pubsub`
   - Refresh token is stored encrypted in the DB.

### Fill in `.env.local`

```bash
GOOGLE_CLOUD_PROJECT=goldinkollar-nexus
GMAIL_PUBSUB_TOPIC=projects/goldinkollar-nexus/topics/nexus-gmail-events
GMAIL_PUBSUB_SUBSCRIPTION=projects/goldinkollar-nexus/subscriptions/nexus-gmail-push
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_SERVICE_ACCOUNT_EMAIL=nexus-gmail-push@goldinkollar-nexus.iam.gserviceaccount.com
```

### Test

After the first OAuth authorisation, send yourself an email and check that the Pub/Sub subscription shows "1 unacked message", then the `interactions` table gets a row.

---

## 6. Telegram bot (fallback approval surface)

Telegram is now the **fallback** (the Android app is primary). Still needed when the phone is out of battery or offline.

### Steps

1. Open Telegram → search `@BotFather` → `/newbot`
2. Name: `Nexus Admin Bot`
3. Username: `nexus_goldinkollar_bot` (must be unique and end in `bot`)
4. BotFather replies with a token like `123456789:AAH-abcdef...` → this is `TELEGRAM_BOT_TOKEN`.
5. `/setprivacy` → **Disable** (so the bot can see all messages in groups, not just commands)
6. `/setjoingroups` → **Enable**
7. **Find your own Telegram user ID**:
   - Message `@userinfobot` or `@RawDataBot`
   - Copy the numeric ID (e.g., `123456789`) → this is `TELEGRAM_ADMIN_USER_IDS`

### Fill in `.env.local`

```bash
TELEGRAM_BOT_TOKEN=123456789:AAH-...
TELEGRAM_ADMIN_USER_IDS=123456789
TELEGRAM_SECRET_TOKEN=<openssl rand -hex 32>
TELEGRAM_WEBHOOK_URL=https://nexus.goldinkollar.com/api/ingest/telegram
```

### Register the webhook (once after deploy)

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${TELEGRAM_WEBHOOK_URL}\",\"secret_token\":\"${TELEGRAM_SECRET_TOKEN}\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
```

### Test

Send `/start` to the bot. You should get a welcome response once Phase 9 ships.

---

## 7. Anthropic / OpenAI / AssemblyAI — API keys

Pure key-paste. No MCPs, just sign up and copy.

| Service | Where | Var(s) | Notes |
|---|---|---|---|
| **Anthropic** | https://console.anthropic.com/settings/keys | `ANTHROPIC_API_KEY` | Pre-purchase $200 credits for Phase 4. Default model `claude-sonnet-4-5-20250929` |
| **OpenAI** (Whisper) | https://platform.openai.com/api-keys | `OPENAI_API_KEY` | Pre-purchase $100 credits. Used for transcription |
| **AssemblyAI** (diarization) | https://www.assemblyai.com/app/account | `ASSEMBLYAI_API_KEY` | Optional; only used for multi-speaker audio. Free tier covers Phase 3 |

---

## 8. Inngest — durable workflows

1. https://app.inngest.com → **Sign up** (free tier is enough for Phase 0–4)
2. Create an environment: `production`
3. **Environment → Event Keys → Create** → copy → `INNGEST_EVENT_KEY`
4. **Environment → Signing Keys → View** → copy → `INNGEST_SIGNING_KEY`
5. After deploy, register the serve endpoint:
   - Apps → **Sync new app** → URL: `https://nexus.goldinkollar.com/api/inngest`
   - Inngest auto-discovers functions.

---

## 9. Cloudflare R2 — audio storage

1. https://dash.cloudflare.com → R2 → **Create bucket**: `nexus-attachments`, jurisdiction `EU`
2. R2 → **Manage R2 API Tokens** → **Create** → Permission: Object Read & Write, Specify bucket: `nexus-attachments`
3. Copy: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` (from R2 dashboard URL)
4. Enable a public custom domain if you want signed preview URLs (optional): `r2.goldinkollar.com` → `R2_PUBLIC_BASE_URL`

---

## 10. Upstash Redis — idempotency + rate-limit

1. https://console.upstash.com → **Create database**
2. Type: **Regional**, region: `eu-central-1` (Frankfurt)
3. Enable **REST API** (for edge-compatible requests)
4. Copy: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

---

## 11. Firebase — push notifications (deferred to Phase 7)

Skip this for now. When we start Phase 7 (Android app), we'll:
1. Create Firebase project, add Android app
2. Download `google-services.json` (goes in the Android app)
3. Enable Cloud Messaging API
4. Create a service account JSON for the Next.js server → `FIREBASE_SERVICE_ACCOUNT_JSON` (base64-encoded env var)

---

## 12. Samsung S24 call recording — Orange/Vodafone strategy

### Current situation

- You're on Orange + Vodafone Egypt.
- Samsung's built-in call recorder is **not available in Egypt** by default (region-locked). Even if present, it's unreliable on Android 14+ because Google's restrictions block apps from accessing call audio.
- You said you can install third-party call-recording apps. **This is now our primary strategy.**

### Updated Phase 8 plan (revised)

- **Wave A' — Third-party recorder integration**: Nexus Android app watches the known output folders of popular recorder apps (e.g., `/Recordings/Call/`, `/Android/data/com.ruralgeeks.callrecorder/files/`, `/RealCall/Recordings/`). When a new file appears, we upload it to R2 and create an `interactions` row with `channel=phone, content_type=call`. Works with any recorder the user installs.
- **Wave B — Mic-only foreground service fallback**: If the user doesn't have a recorder installed, Nexus's own foreground service can record via the microphone during calls. Catches your side of the conversation cleanly; other side is muffled through the speaker (acceptable for short call summaries). Requires `RECORD_AUDIO` + notification to comply with Google Play policy.
- **Wave C — Manual upload**: UI to upload an audio file after the fact. Always available as a backstop.

### Action for you (one-time test)

Install one of these on your S24 and record a test call:

| App | Pros | Cons |
|---|---|---|
| **Cube ACR** | Works on most devices, auto-uploads | Accessibility service required |
| **Automatic Call Recorder (Google)** | Native-feel | Dropped support in many regions |
| **BoldBeast** | Root-optional advanced control | UI dated |
| **Truecaller** (has recorder) | You may already have it | Ad-heavy |

Tell me which recorder you pick and I'll wire the folder path into the Phase 8 Android code.

### Confirmation needed

- [ ] Orange: install a test app, record a 30-second call, confirm file lands in a folder the S24 file manager can see
- [ ] Vodafone: same test on the Vodafone SIM if you use both

This **only blocks Phase 8**. Phases 1–7 ship without it.

---

## Summary — what you have to do right now

| Priority | Task | Time | Unblocks |
|---|---|---|---|
| 🔴 **P0** | Supabase password reset + copy 2 strings ([§1](#1-supabase--2-minute-db-password-reset)) | 2 min | Local dev |
| 🔴 **P0** | Create GitHub repo + push ([§3](#3-github--create-repo--push)) | 3 min | CI, backups |
| 🟡 **P1** | Vercel link + deploy ([§2](#2-vercel--deploy-the-web-app)) | 5 min | Webhooks reachable |
| 🟡 **P1** | Telegram bot via @BotFather ([§6](#6-telegram-bot-fallback-approval-surface)) | 3 min | Phase 9 fallback |
| 🟡 **P1** | WhatsApp Business — **decide A or B**, then set up ([§4](#4-whatsapp-business-cloud-api)) | 20 min | Phase 1 ingestion |
| 🟢 **P2** | Gmail Workspace OAuth + Pub/Sub ([§5](#5-gmail-workspace-pubsub-watch)) | 15 min | Phase 1 ingestion |
| 🟢 **P2** | Anthropic + OpenAI + Inngest + R2 + Upstash keys ([§7](#7-anthropic--openai--assemblyai--api-keys)–[§10](#10-upstash-redis--idempotency--rate-limit)) | 10 min | Phase 4–5 |
| ⚪ **P3** | Install S24 call recorder and do a test ([§12](#12-samsung-s24-call-recording--orangevodafone-strategy)) | 5 min | Phase 8 only |

**Do P0 + P1 today.** P2 before Phase 4 starts. P3 before Phase 8.

Questions? Just tell me. I'll handle everything that can be handled via MCP or code.
