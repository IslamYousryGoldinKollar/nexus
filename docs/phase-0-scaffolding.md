# Phase 0 — Scaffolding

> Status: **complete**. Delivered 2026-04-17.

Phase 0 lays down the skeleton. Nothing here processes real client data yet — ingestion webhooks return 200 but don't persist, reasoning and approvals are Phase 4-7. The goal is: everything compiles, deploys, and is ready for Phase 1 to drop in real logic behind the stubs.

---

## What shipped

### Monorepo
- `pnpm` workspaces + Turborepo 2.x
- Strict TypeScript 5.6 base config (`tsconfig.base.json`) with `noUncheckedIndexedAccess` on
- Prettier + `.editorconfig` + `.nvmrc` pinned to Node 20.11.0
- Conventional `.gitignore`, `.prettierignore`

### Packages
- **`@nexus/shared`** — Zod schemas for every Inngest event, channel/enum constants, `parseServerEnv()` fail-fast validator.
- **`@nexus/db`** — Drizzle schema v1 with all 12 tables from the original spec PLUS the 4 architectural additions from the plan file (`users`, `devices`, `device_pairing_tokens`, `notifications`, `cost_events`). `postgres-js` client wrapper (pooled + unpooled). `drizzle.config.ts`, `scripts/migrate.ts`, `scripts/seed.ts`.
- **`@nexus/inngest-fns`** — Typed Inngest client bound to the `@nexus/shared` event schemas. One placeholder function (`hello`) proves the pipeline.

### Next.js 15 app (`apps/web`)
- App Router, strict mode, Turbopack dev
- Tailwind 3 + shadcn/ui tokens (GK gold + deep navy in `globals.css`)
- `@/` path alias
- Landing page + seven admin shell pages (dashboard, approvals, sessions, contacts, pending-identifiers, costs, settings) backed by a reusable `AdminPlaceholder` component that documents what each page will do and in which phase.
- Six API routes — signature-verifiable stubs for WhatsApp / Gmail / Telegram / Phone / Teams + the Inngest serve endpoint + a liveness `health` endpoint.
- `vercel.json` with region `fra1` (closest to Egypt) and per-route `maxDuration` tuned for call-recording uploads + Inngest replay.

### CI
- GitHub Actions workflow (`.github/workflows/ci.yml`):
  - Job 1: install → lint → typecheck → test
  - Job 2: spin up ephemeral Postgres 16 → `drizzle-kit generate` → `git diff --exit-code` to catch schema/migration drift

### Docs
- [`docs/architecture.md`](architecture.md) — the working map.
- This file.
- [`README.md`](../README.md) — local dev, scripts, deploy, phase roadmap.

---

## Design decisions vs the spec

Two deliberate deviations from the original `nexus_claude_code_prompt.md`:

1. **`SESSION_COOLDOWN_MIN` defaults to 120, not 30.** 30 min fragments real client threads and multiplies Claude cost. The 2-hour default is overrideable per-contact when we get to Phase 2. See architecture.md §6.
2. **`cost_events` table is Phase 0, not Phase 7.** You need observability on spend from day 1 of Claude/Whisper usage. The schema exists now; Phase 5 adds the dashboard.

Plus the 4 new tables called out in the plan:

| Table | Why |
|-------|-----|
| `users` | Future-proof multi-user without a migration. Seed row = Islam. |
| `devices` | Per-device API keys + FCM tokens for the Android app. |
| `device_pairing_tokens` | Short-lived QR-code pairing from web → mobile. |
| `notifications` | Every ping (FCM + Telegram + in-app). Feeds the fallback Inngest flow. |

---

## Gotchas / caveats

### IDE "module not found" noise before install
Until `pnpm install` runs, the IDE reports `Cannot find module 'zod'`, `Cannot find module '@nexus/shared'`, etc. Expected — all of those vanish after install. The imports use ESM `.js` extensions (`./channels.js`) because TypeScript with `moduleResolution: Bundler` resolves those to `./channels.ts` at build time. Do not remove them.

### `packages/shared` exports raw TS, not compiled JS
To keep dev velocity high, the shared packages `main` their TS source files and rely on Next.js's `transpilePackages` option. For a future NPM publish we'd add a proper `tsup` or `tsc` build step, but we don't need it now.

### Next.js 15 + React 19 (stable)
Next 15.1+ ships on React 19 stable. The `package.json` pins `^19.0.0` for `react` / `react-dom` with matching `@types/react@^19.0.0` to keep the IDE and builds aligned.

### Webhook stubs are `phase: 0` no-ops
Every ingestion route returns `{ ok: true, phase: 0 }` after a minimal signature check (where we can already do one without real logic, e.g., Telegram secret-token header, WhatsApp hub-verify-token handshake, phone/teams bearer token). **Phase 1 will replace each with real HMAC verification + persistence.**

### Drizzle migrations applied via Supabase MCP
The schema is live on the Supabase `nexus` project (ref `clwvamwweevvmqyfqkzq`, `eu-central-1`). 17 tables created + RLS enabled (no policies = deny-all to anon; service_role bypasses). The migration file is checked in at `packages/db/drizzle/0000_smiling_joshua_kane.sql` so CI can dry-run it on every PR.

CI's migration-dryrun job will enforce this stays in sync thereafter.

---

## Deferred to Phase 1

- Real WhatsApp HMAC signature verification + persistence
- Gmail Pub/Sub JWT verification + historyId polling
- Telegram webhook → grammY handler
- Phone ingest → multipart parsing + R2 upload + checksum dedup
- MS Teams ingest → Chrome-extension protocol (specced in Phase 10)

---

## Definition of done (all checked)

- [x] Monorepo scaffolded with pnpm + Turbo
- [x] Drizzle schema v1 (12 spec tables + 4 additions) + migration script
- [x] Next.js 15 app with all six API routes + seven admin pages
- [x] `.env.example` covers every required variable
- [x] README with local dev instructions
- [x] Docs/architecture.md + this phase doc
- [x] CI pipeline (lint / typecheck / test / migration dry-run)
- [x] Initial Drizzle migration generated + applied to Supabase `nexus`
- [x] RLS enabled on every table (security posture for Phase 0)
- [x] Super-admin user (`islam.yousry@goldinkollar.com`) seeded
- [ ] Deployed to staging Vercel URL — **blocked: user needs to run `vercel link` + provide env vars**
- [ ] Pushed to GitHub — **blocked: user needs to create repo**

Remaining unchecked items are credential-paste operations; see [`onboarding.md`](./onboarding.md).

---

## Open questions carried into Phase 1

From the master plan §10:

1. WhatsApp Cloud API confirmed? (assumed Cloud)
2. Gmail Workspace vs personal?
3. Who owns each infra account (me invited, or service accounts)?
4. Domain `nexus.goldinkollar.com`?
5. GitHub repo name + ownership?
6. Telegram bot new or existing?
7. Samsung S24 carrier-recording test (Phase 8 blocker, not Phase 1)

Phase 1 cannot proceed on WhatsApp/Gmail until #1-3 are resolved. Telegram, Teams, and Phone can proceed independently.
