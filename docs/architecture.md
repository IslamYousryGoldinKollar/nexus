# Nexus — Architecture

> Reference document. Version 1 — Phase 0. Amended as we learn.

This is the single doc to read if you want to understand Nexus end-to-end. It's not a spec — it's the **working map** of how the pieces fit together, what the invariants are, and why we chose what we chose.

---

## 1. Product one-liner

Nexus is an AI Chief of Staff for Islam (GoldinKollar). It ingests every client communication across WhatsApp, Gmail, Telegram, phone calls, and MS Teams; aggregates them into bounded **Sessions**; reasons over each session with Claude Sonnet 4.5; proposes tasks; waits for Islam's approval on the mobile app (with a Telegram fallback); syncs approved tasks to Injaz (`injaz.goldinkollar.com`).

**It never writes to clients.** It only surfaces proposals for humans to act on.

---

## 2. The central insight

Meaning lives in threads, not atoms. A voice note by itself is a fragment; the same voice note combined with the prior email, the next three WhatsApp messages, Islam's reply, and the 22-minute call that followed is a *decision point*. Nexus's primary abstraction — the **Session** — exists to capture that thread and reason over it holistically.

---

## 3. Top-level architecture

```
┌─── CHANNELS ────────────────────────────────────────────────────────────┐
│ WhatsApp · Gmail · Telegram · Phone calls · MS Teams                    │
└────┬─────┬─────────┬──────────┬──────────────┬─────────────────────────┘
     │     │         │          │              │
     ▼     ▼         ▼          ▼              ▼
┌─── INGESTION (Next.js webhooks, <500ms, thin) ──────────────────────────┐
│ Verify signature · persist `interactions` · emit Inngest event          │
└────┬────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─── INNGEST DURABLE WORKFLOWS ────────────────────────────────────────────┐
│ resolve identity  →  attach to session  →  transcribe (if audio)         │
│                                          ↓                                │
│                               (session cools down or trigger)             │
│                                          ↓                                │
│                               reason-on-session (Claude)                  │
│                                          ↓                                │
│                               notify-on-proposal                          │
│                                     │         │                           │
│                                     ▼         ▼ (sleep 30m)               │
│                                   FCM push   Telegram fallback            │
└────┬────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─── STATE LAYER ────────────────────────────────────────────────────────┐
│ Supabase Postgres (Drizzle) · Upstash Redis (cache/locks) · R2 (blobs)  │
└────┬────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─── APPROVAL SURFACES ───────────────────────────────────────────────────┐
│ Android app (PRIMARY)  ·  Web admin (PRIMARY)  ·  Telegram (FALLBACK)   │
└────┬────────────────────────────────────────────────────────────────────┘
     │ approval
     ▼
┌─── DOWNSTREAM ─────────────────────────────────────────────────────────┐
│ Injaz sync (MCP + REST) — tasks created + files attached via Drive      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Core abstractions (schema-level)

| Concept | Table | Role |
|---------|-------|------|
| **Account** | `accounts` | Optional grouping of contacts (e.g., "e& Egypt"). |
| **Contact** | `contacts` | A real human we communicate with. |
| **ContactIdentifier** | `contact_identifiers` | ONE way to reach a human (phone/email/handle). Many-to-one with contact. |
| **PendingIdentifier** | `pending_identifiers` | Unknown identifier awaiting human linkage — the queue for HITL decisions. |
| **Session** | `sessions` | Bounded conversation context — staging area for reasoning. State machine. |
| **Interaction** | `interactions` | Polymorphic atom (text / voice / email / call / meeting). `UNIQUE(channel, source_message_id)` for idempotent retries. |
| **Attachment** | `attachments` | Binary blob in R2. Deduped by checksum. |
| **Transcript** | `transcripts` | Processed audio/video text. Cached by attachment checksum. |
| **ReasoningRun** | `reasoning_runs` | One Claude execution over a session. Full context + response preserved for replay. |
| **ProposedTask** | `proposed_tasks` | Claude's suggestion, pre-approval. |
| **ApprovedTask** | `approved_tasks` | Mirror of the Injaz task, tracks sync + drift. |
| **ApprovalEvent** | `approval_events` | Audit trail for every approve/edit/reject, regardless of surface. |
| **User** | `users` | v1 = Islam. Future-proofed for RBAC via `role` column. |
| **Device** | `devices` | Paired Android phones / web sessions. Has its own API key + FCM token. |
| **Notification** | `notifications` | Every ping. Feeds in-app inbox + Inngest fallback workflows. |
| **CostEvent** | `cost_events` | Per-operation cost ledger. Drives the circuit breakers. |

### Why this schema works

- Every identifier is a row, not a column — one person can have 3 phones + 2 emails.
- Interactions are polymorphic but flat — ONE query to read a session.
- Sessions are a state machine (see §6).
- Proposed vs Approved tasks are separate — the audit trail is sacred.
- `UNIQUE(channel, source_message_id)` gives us idempotent webhook retries for free.

---

## 5. Invariants (things that MUST always be true)

1. **Webhooks return 200 <500ms.** Any real work goes to Inngest. No exceptions.
2. **Every webhook verifies its signature.** No exceptions, even in dev — we use a test secret.
3. **Nexus never sends messages to clients.** Only to Telegram (to Islam) and Injaz (internal).
4. **Approval is required on Path B.** No code path bypasses human approval for LLM-proposed tasks.
5. **Identity auto-merges are forbidden during the learning period.** `IDENTITY_LEARNING_MODE=true` for first 30 days routes every non-exact match through HITL.
6. **`any` is banned.** Use `unknown` + Zod or proper type narrowing.
7. **Route handlers are thin.** Business logic lives in `packages/*`, not in `app/api/**`.
8. **Costs are metered.** Every Claude / Whisper / AssemblyAI call writes a `cost_events` row, and a circuit breaker trips at 100% of `*_MONTHLY_BUDGET_USD`.

---

## 6. Session state machine

```
       ┌─────┐  new interaction, no open session for contact
       │OPEN │◀─────
       └──┬──┘
          │ every new interaction while open
          ▼
   ┌──────────────┐
   │ AGGREGATING  │
   └──────┬───────┘
          │ silence_timeout | manual | cron | command
          ▼
   ┌──────────────┐
   │  REASONING   │  — Claude runs over context bundle
   └──────┬───────┘
          │ reasoning produces proposed tasks (may be empty)
          ▼
  ┌──────────────────────┐
  │  AWAITING_APPROVAL   │  — mobile + web show proposals; FCM push fires
  └────┬───────────┬─────┘
       │ approve   │ reject
       ▼           ▼
  ┌──────────┐ ┌──────────┐
  │ APPROVED │ │ REJECTED │
  └────┬─────┘ └────┬─────┘
       │ sync       │
       ▼            │
  ┌─────────┐       │
  │ SYNCED  │       │
  └────┬────┘       │
       ▼            ▼
     ┌───────────────────┐
     │      CLOSED       │
     └───────────────────┘
```

**ERROR** is a terminal state reachable from any step. Recovery is a manual admin action (`/retry <session_id>`).

**Transition triggers — `AGGREGATING → REASONING`:**
- `silence_timeout` — no interaction for `SESSION_COOLDOWN_MIN` (default **120 min**, promoted from the spec's 30 min)
- `manual` — operator posts `/analyze <session_id>`
- `cron` — scheduled sweep every `SESSION_SWEEP_CRON` (default 2h)
- `command` — client message starts with `/task` or `/done` (Path A)

Unit-tested in `packages/db/src/session-machine.test.ts` (Phase 2).

---

## 7. Notification subsystem

| Event | FCM push | Telegram (fallback) | Delay |
|-------|----------|---------------------|-------|
| `proposal.created` | immediate | if unread after 30 min | 30 m |
| `identifier.pending` | immediate | if unlinked after 10 min | 10 m |
| `session.error` | immediate | immediate (both) | 0 |
| `cost.budget_warn` (80%) | immediate | immediate | 0 |
| `cost.budget_exceeded` (100%) | immediate | immediate **+ circuit break** | 0 |
| `injaz.sync_failed` | immediate | after 1 hr unread | 60 m |
| `digest.daily` | 21:00 local (opt-in) | — | — |

All delays are configurable via env (`NOTIFY_FALLBACK_*_MIN`). Inngest `step.sleep` + re-read pattern guarantees durability across deploys.

---

## 8. Mobile app (Phase 7+)

- **Platform:** Android only (Kotlin + Jetpack Compose) on Samsung S24.
- **Role:** primary approval surface, admin console, call recorder.
- **Auth:** QR-code pairing from web → device JWT + biometric gate on destructive actions.
- **Offline:** read-only cache via Room; writes queued with last-writer-wins.
- **Recording:** Wave A (carrier files in `/Recordings/Call/`) first; Wave B (mic-only foreground service) only if Wave A fails.

Full spec in `docs/mobile-app.md` (written in Phase 7).

---

## 9. Decisions log

| Decision | Rationale |
|----------|-----------|
| Next.js 15 App Router on Vercel | Webhooks + admin UI in one deploy; edge-compatible health + CDN for static. |
| Drizzle over Prisma | Type safety + raw SQL escape hatch; thinner at this scale. |
| Inngest over QStash/BullMQ | Multi-step durable workflows with replay; we need `sleep 30m` as a first-class op. |
| OpenAI GPT-4o-mini as primary reasoner (default since 2026-04-23, commit `3494bd1`) | ~20× cheaper than Sonnet for our session sizes; quality trade-off acceptable for v1. Anthropic Sonnet 4.6 path retained in `packages/services/src/reason.ts` as a fallback — flip via `provider: 'anthropic'` arg or set `ANTHROPIC_MODEL` + remove the OpenAI default. |
| Supabase Postgres 17 | Managed PG + free auth/storage/realtime; branching for safe CI migrations; agent can provision and migrate via MCP. |
| pnpm + Turbo | Fast monorepo builds; Vercel's native support. |
| Android only (no iOS) | iOS blocks call recording at OS level; single platform keeps scope sane. |
| Mobile primary / Telegram fallback | User preference (see plan file). Telegram loses its "primary HITL" status from the original spec. |
| RBAC future-proofed, but single-user v1 | `users.role` column exists; no UI yet — add later via INSERT, no migration. |
| In-memory rate limiting (sliding window) | Acceptable on a single Vercel function instance per IP source; revisit with Upstash Redis if we ever scale horizontally past one warm container. |
| Edge middleware applies security headers + request-id globally | Centralizes baseline cross-cutting concerns; per-route handlers don't need to remember to add CSP/X-Frame/etc. Request-id is plumbed through `lib/request-id.ts` ALS so any `runWithRequestId(...)`-wrapped handler gets auto-tagged log lines. |

---

## 10. Non-goals (v1)

- Chatbot / outbound to clients
- Full-text search across sessions (Phase 7+ if needed)
- CRM-style deal value / pipeline (Injaz owns that)
- Voice cloning for replies
- iOS
- Client-facing portal
- Auto-merging duplicate contacts

---

## 11. Where to dig next

- [`docs/phase-0-scaffolding.md`](phase-0-scaffolding.md) — what Phase 0 delivered, gotchas.
- [`docs/runbook.md`](runbook.md) — incident response (written alongside Phase 11).
- [`packages/db/src/schema/`](../packages/db/src/schema/) — the authoritative schema.
- [`packages/shared/src/events.ts`](../packages/shared/src/events.ts) — every Inngest event shape.
