# Nexus

**AI Chief of Staff for GoldinKollar.** Ingests every client communication across WhatsApp, Gmail, Telegram, phone calls, and MS Teams; aggregates them into bounded **Sessions**; reasons over each session with Claude Sonnet 4.5; proposes tasks; waits for your approval on the mobile app (fallback to Telegram); syncs approved tasks to Injaz.

> **Phase 0 — Scaffolding.** This is the skeleton. Ingestion webhooks return 200 but do not yet persist; reasoning and approvals land in later phases per [`docs/phase-0-scaffolding.md`](docs/phase-0-scaffolding.md).

---

## Repository layout

```
nexus/
├── apps/
│   ├── web/                  Next.js 15 — webhooks + admin UI + mobile API
│   └── android/              (Phase 7) Kotlin + Compose — recorder + approvals
├── packages/
│   ├── db/                   Drizzle schema + client + migrations
│   ├── shared/               Zod schemas, enums, event types, env parser
│   └── inngest-fns/          Durable workflows (hello-world only in Phase 0)
├── docs/                     Architecture, per-phase design notes, runbook
└── .github/workflows/        CI: lint + typecheck + test + migration dry-run
```

See [`docs/architecture.md`](docs/architecture.md) for the full design.

---

## Local development

### Prerequisites

- Node.js `>= 20.11.0` (`.nvmrc` is set; use `nvm use`)
- pnpm `>= 9.0.0` (`corepack enable` or `npm i -g pnpm@9`)
- A Neon Postgres project (free tier fine for dev) — or any Postgres 14+
- Inngest CLI for local workflow development (`npx inngest-cli@latest dev`)

### Setup

```bash
# 1. Clone + install
git clone <repo-url> nexus && cd nexus
pnpm install

# 2. Copy env + fill in DATABASE_URL at minimum
cp .env.example .env.local
# edit .env.local — set DATABASE_URL (and DATABASE_URL_UNPOOLED if different)

# 3. Generate + apply Drizzle migrations
pnpm db:generate
pnpm db:migrate

# 4. Start the dev server
pnpm dev
# → http://localhost:3000       (admin UI)
# → http://localhost:3000/api/health   (liveness)

# 5. In a second terminal, start Inngest dev server
npx inngest-cli@latest dev
# → http://localhost:8288
```

### Useful scripts

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Starts all workspaces in dev mode |
| `pnpm build` | Builds every workspace in dependency order |
| `pnpm lint` | Lints every workspace |
| `pnpm typecheck` | Runs `tsc --noEmit` in every workspace |
| `pnpm test` | Runs Vitest in every workspace |
| `pnpm format` | Prettier-formats the entire tree |
| `pnpm db:generate` | Regenerate Drizzle migrations from schema |
| `pnpm db:migrate` | Apply migrations to the DB in `DATABASE_URL_UNPOOLED` |
| `pnpm db:studio` | Open Drizzle Studio on your DB |
| `pnpm db:push` | Push schema directly (dev-only shortcut) |

---

## Environment variables

See [`.env.example`](.env.example) for the full list with comments.

**Required for local dev (everything else can be blank until that phase):**

- `DATABASE_URL` — Neon or local Postgres
- `APP_URL` — `http://localhost:3000` for dev

**Required to reach Phase 0 staging deploy:**

- All of the above
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`
- `AXIOM_TOKEN`, `AXIOM_DATASET` (observability)
- `SENTRY_DSN` (error tracking)

**Required per phase as we land them:** see the corresponding `docs/phase-N-*.md`.

---

## Deployment

### Vercel (web app)

The web app is configured for Vercel deploys via `apps/web/vercel.json`. The first deploy will ask you to link the project:

```bash
# From repo root
pnpm dlx vercel link --cwd apps/web
pnpm dlx vercel deploy --cwd apps/web
```

Set env vars in the Vercel dashboard under the project's **Settings → Environment Variables**. Use the same names as `.env.example`.

### Inngest

```bash
pnpm dlx inngest-cli@latest deploy --url https://nexus.goldinkollar.com/api/inngest
```

### Neon migrations (production)

Migrations run automatically in CI on merge to `main` (see `.github/workflows/ci.yml`). To apply them manually against a specific DB:

```bash
DATABASE_URL_UNPOOLED=<neon-unpooled-url> pnpm db:migrate
```

---

## Security posture

- No secrets in source. Everything lives in env vars.
- Webhook signatures verified on every ingestion endpoint (Phase 1+).
- Audio files encrypted at rest in R2 (SSE).
- Telegram admin IDs in env, not DB.
- Device API keys hashed (bcrypt) in the `devices` table.
- Identity resolution defaults to "learning mode" for the first 30 days — all non-exact matches go through human approval.

See [`docs/runbook.md`](docs/runbook.md) for incident response, key rotation, and replay procedures.

---

## Phase roadmap

| Phase | Scope | Target |
|-------|-------|--------|
| **0** | **Scaffolding** — monorepo, Next.js, Drizzle, Inngest, CI | **Current** |
| 1 | Ingestion webhooks (WhatsApp, Gmail, Telegram, Phone, Teams) | 3 days |
| 2 | Identity resolver + session state machine | 3 days |
| 3 | Transcription (Whisper + AssemblyAI) | 2 days |
| 4 | Reasoning engine (Claude Sonnet 4.5) | 4 days |
| 5 | Web admin UI + approvals + costs dashboard | 4 days |
| 6 | Injaz sync | 2 days |
| 7 | Android app: foundation + approvals + FCM | 6 days |
| 8 | Android app: call recording | 5 days |
| 9 | Telegram fallback bot + notification router | 3 days |
| 10 | MS Teams (Chrome extension) | 3 days |
| 11 | Observability + runbook + budget circuit breakers | 2 days |

---

## License

Proprietary. © GoldinKollar. Not for redistribution.
