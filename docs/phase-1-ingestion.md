# Phase 1 — Ingestion Webhooks

**Status:** in-progress (code + tests complete; awaiting external credentials to run end-to-end).

**Scope:** accept inbound client communication on every channel, verify each delivery, persist a normalized `interactions` row, materialize any media to R2, and emit `nexus/interaction.ingested` so the durable-workflow layer can take over in Phase 2.

**Non-goals:**
- Identity resolution (Phase 2)
- Session creation (Phase 2)
- Transcription / reasoning / approvals (Phase 3+)
- Outbound writes to any channel (never)

---

## What shipped

### Shared crypto — `@nexus/shared`

- `hmac(secret, body, algo)` — Web Crypto HMAC, bytes out
- `verifyHmac(secret, body, signature, algo)` — accepts Meta-style `sha256=<hex>` prefix, rejects malformed hex safely
- `timingSafeEqual` / `safeStringEqual` — constant-time comparisons
- `hexToBytes` / `bytesToHex` — no-dep conversions

Full test coverage in `packages/shared/src/crypto.test.ts` — 20 tests including the RFC 4231 test vector for SHA-256 HMAC.

### DB query helpers — `@nexus/db`

- `upsertInteraction(db, row)` — idempotent insert using the `UNIQUE(channel, source_message_id)` constraint. Reads-then-inserts, falls back to another read on unique-violation races. Returns `{ interaction, inserted }` so callers know whether to download media.
- `insertAttachment(db, row)` — paired row in `attachments` linked to the interaction.
- `getInteractionBySourceId` / `findAttachmentByChecksum` — lookup helpers used by the replay script and the admin UI.

### R2 client — `apps/web/lib/r2.ts`

- S3-compatible `@aws-sdk/client-s3` wrapper.
- Content-addressed key layout: `{channel}/{yyyy}/{mm}/{dd}/{sha256-hex}{ext}`. Uploading the same bytes twice is a no-op (HEAD first, skip if present).
- `uploadToR2({ channel, bytes, mimeType, occurredAt })` returns `{ key, checksumHex, sizeBytes, mimeType, alreadyExisted }`.
- `getSignedDownloadUrl(key, ttl)` — 15-min default TTL for admin-UI previews.

### Common webhook utilities — `apps/web/lib`

- `raw-body.ts` — `readRawBody(req)` returns the exact bytes the sender signed (critical for HMAC).
- `webhook-response.ts` — `ack`, `signatureFailed`, `badRequest`, `unauthorized`, `forbidden`, `serverError`. Everywhere we can we ACK with 200 + error body to prevent retry storms from bad configs.
- `logger.ts` — one-line structured JSON logs (`ts/level/event/…`) that work out-of-the-box with Vercel + Axiom.
- `env.ts` — `serverEnv` Proxy (lazy) + `env()` (explicit) exports the frozen `parseServerEnv` result.

### Channels

Every channel follows the same five-step pipeline:

1. **Verify authenticity** (HMAC / secret-token / OIDC JWT / API key)
2. **Parse raw body** → Zod schema
3. **Normalize** into our `interactions` shape
4. **Persist + materialize** (`upsertInteraction` → download media → `uploadToR2` → `insertAttachment`)
5. **Emit** `nexus/interaction.ingested` if the row was newly inserted

#### WhatsApp — `POST /api/ingest/whatsapp`

- **Auth:** HMAC-SHA256 over raw body, `X-Hub-Signature-256: sha256=<hex>`, secret = `WHATSAPP_APP_SECRET`.
- **Subscribe handshake:** `GET` handler implements Meta's `hub.mode=subscribe`/`hub.verify_token`/`hub.challenge` dance.
- **Supported message types:** text, image, audio (voice notes), video, document, sticker, location, contacts, button, interactive. Reactions + unknown types are logged and skipped.
- **Media:** two-step Graph API download (`GET /v21.0/{media_id}` → `GET {short_lived_url}`), then `uploadToR2`. Attachment row links the R2 key to the interaction.
- **Statuses (delivered/read/failed):** logged, not persisted (not ingestion-worthy).
- **Files:**
  - `apps/web/lib/channels/whatsapp/schema.ts`
  - `apps/web/lib/channels/whatsapp/media.ts`
  - `apps/web/lib/channels/whatsapp/ingest.ts`
  - `apps/web/app/api/ingest/whatsapp/route.ts`
  - `apps/web/app/api/ingest/whatsapp/route.test.ts` (9 integration tests)
  - `apps/web/lib/channels/whatsapp/schema.test.ts` (7 tests)

#### Telegram — `POST /api/ingest/telegram`

- **Auth:** constant-time compare on `X-Telegram-Bot-Api-Secret-Token` vs `TELEGRAM_WEBHOOK_SECRET`. This secret is set when we `setWebhook?secret_token=…`.
- **Supported message types:** text, voice, audio, video, video_note, photo (picks the largest resolution), document, sticker, location, contact. Edited messages + callback_query reserved for Phase 9.
- **Source id:** `{chat_id}:{message_id}` — globally unique per (chat, message) pair.
- **Media:** two-step (`getFile?file_id=…` → `GET /file/bot<token>/<file_path>`), identical pattern to WhatsApp.
- **Files:**
  - `apps/web/lib/channels/telegram/schema.ts`
  - `apps/web/lib/channels/telegram/media.ts`
  - `apps/web/lib/channels/telegram/ingest.ts`
  - `apps/web/app/api/ingest/telegram/route.ts`
  - `apps/web/app/api/ingest/telegram/route.test.ts` (7 tests)
  - `apps/web/lib/channels/telegram/schema.test.ts` (6 tests)

#### Gmail — `POST /api/ingest/gmail`

- **Auth:** Google-issued OIDC JWT in `Authorization: Bearer`, RS256 verified against the JWKS at `https://www.googleapis.com/oauth2/v3/certs`. Audience must match our webhook URL; email claim verified (and optionally matched against `GMAIL_PUBSUB_SERVICE_ACCOUNT`).
- **Envelope:** `pubsubPushSchema` accepts Google's Pub/Sub push shape; `gmailNotificationSchema` validates the decoded `{ emailAddress, historyId }` inside `message.data` (base64).
- **Phase 1 action:** log the notification. Actually fetching the History API + persisting new messages as `interactions` is deferred to **Phase 1.5** because it requires the OAuth consent flow. The Pub/Sub subscription will backfill those messages once OAuth tokens exist.
- **Files:**
  - `apps/web/lib/channels/gmail/schema.ts`
  - `apps/web/lib/channels/gmail/verify-oidc.ts`
  - `apps/web/app/api/ingest/gmail/route.ts`
  - `apps/web/lib/channels/gmail/schema.test.ts` (4 tests)

#### Phone — `POST /api/ingest/phone`

- **Auth:** bearer token in `Authorization: Bearer <key>` compared constant-time against `PHONE_INGEST_API_KEYS` (comma-separated). Phase 7 replaces this with per-device keys backed by the `devices` table + HMAC body signatures.
- **Body:** multipart/form-data with two fields: `audio` (File) + `meta` (JSON string matching `phoneUploadMetaSchema`: `counterparty`, `direction`, `startedAt`, `durationSec`, `callId`, optional `recorder`, `transcribe`).
- **Limits:** 50 MB body max; 60-second function timeout.
- **Pipeline:** `uploadToR2` (content-addressed; repeat uploads dedupe) → `upsertInteraction(content_type='call')` → `insertAttachment` → emit `nexus/interaction.ingested`.
- **Files:**
  - `apps/web/lib/channels/phone/schema.ts`
  - `apps/web/lib/channels/phone/auth.ts`
  - `apps/web/lib/channels/phone/ingest.ts`
  - `apps/web/app/api/ingest/phone/route.ts`
  - `apps/web/lib/channels/phone/schema.test.ts` (7 tests)
  - `apps/web/lib/channels/phone/auth.test.ts` (5 tests)

#### Teams

Unchanged Phase 0 stub. Teams ingestion moves to a Chrome-extension forwarder path in Phase 10 — see `docs/architecture.md`.

### Inngest downstream — `@nexus/inngest-fns`

- `onInteractionIngested` (file: `packages/inngest-fns/src/functions/interaction-received.ts`) subscribes to `nexus/interaction.ingested`. Phase 1 body = single `step.run('log', …)`. Phase 2 replaces the body with identity resolution + session attachment — the function id stays stable so Inngest treats every deploy as an update, not a net-new function.

---

## Security posture

| Concern | How we handle it |
|---|---|
| **Forged webhooks** | HMAC / secret-token / OIDC JWT verified before parsing. All comparisons constant-time. |
| **Retry storms** | Bad signatures return 200 with `{error: 'signature_verification_failed'}` so the sender doesn't DoS us. Schema mismatches and JSON parse errors also ACK 200 with a clear `ignored` reason in the log. |
| **Replay attacks** | Idempotency at the DB layer via `UNIQUE(channel, source_message_id)`. Replay works (we're idempotent) but never double-counts. |
| **Tampered bodies** | Raw bytes verified before `JSON.parse`. We never trust parsed JSON for signature checks. |
| **Upload abuse** | Phone endpoint checks bearer token + 50 MB content-length limit + 60 s timeout. Phase 7 upgrades to per-device HMAC. |
| **Secrets in logs** | `logger.ts` never stringifies full payloads by default; routes log structured field summaries only. |
| **RLS on DB** | RLS enabled on all tables; route handlers use the `postgres` role (bypasses RLS); admin UI (Phase 5) uses `service_role`. |

---

## Test inventory

```
packages/shared/src/crypto.test.ts                          20 tests
apps/web/lib/channels/whatsapp/schema.test.ts                7 tests
apps/web/lib/channels/telegram/schema.test.ts                6 tests
apps/web/lib/channels/gmail/schema.test.ts                   4 tests
apps/web/lib/channels/phone/schema.test.ts                   7 tests
apps/web/lib/channels/phone/auth.test.ts                     5 tests
apps/web/app/api/ingest/whatsapp/route.test.ts               9 tests
apps/web/app/api/ingest/telegram/route.test.ts               7 tests
----------------------------------------------------------- --------
                                                            65 tests
```

All suites run in < 2 s total; mocks replace the DB, R2, Inngest, and media-download HTTP calls so the suite is hermetic.

---

## Known limitations & deferred work

- **Gmail message fetch** deferred to Phase 1.5. Needs the OAuth consent flow (`/admin/settings/connections` → Connect Gmail).
- **Phone HMAC body signature** deferred to Phase 7. Today's bearer-token model is vulnerable to key theft via logs / replay; HMAC over `(device_id + body)` fixes both.
- **No circuit-breaker yet** on media-download errors. If Meta's Graph API flaps we will log + move on, but retries are per-webhook, not centralized. Phase 11 adds an Inngest job that replays failed downloads from the `interactions.raw_payload` JSON.
- **Cost tracking** — R2 PUTs and Meta/Telegram media downloads are not yet accounted in `cost_events`. Phase 4 wires the table up as part of the Anthropic budget plumbing.

---

## Definition of done (Phase 1)

- [x] Shared crypto lib + 20 tests
- [x] Idempotent DB query helpers
- [x] R2 upload pipeline
- [x] WhatsApp full ingestion + integration tests
- [x] Telegram full ingestion + integration tests
- [x] Gmail webhook + OIDC verification (fetch deferred)
- [x] Phone upload endpoint
- [x] Inngest `onInteractionIngested` listener (logger for now)
- [x] Structured logging everywhere
- [x] Docs (this file)
- [ ] End-to-end smoke: deploy + send one real WhatsApp message + see a row in Supabase — **blocked on Vercel deploy + WhatsApp credentials (see `docs/onboarding.md`)**

---

## Runbook additions

- `docs/runbook.md` → **Rotate a leaked webhook secret** gets its real content now that Phase 1 is live. TL;DR: rotate the env var in Vercel → redeploy → re-run `setWebhook` (Telegram) or update the Meta dashboard (WhatsApp) → observe the next 10 deliveries land.
- `docs/runbook.md` → **Backfill a missed webhook** — Meta's webhook error-console can replay. For Telegram, `setWebhook` again with the same URL to resume. For phone, re-upload from the device queue.
