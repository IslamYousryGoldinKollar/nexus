# Nexus — Runbook

> How to respond when things break. Written incrementally per phase. Every playbook should read in under 60 seconds at 3am.

## Phase 0 placeholder

Runbook lives here. Filled out against real incidents as phases land. Top of mind:

- **Replay a stuck session** — Phase 4 (Inngest function dashboard + `/api/admin/replay/:sessionId`)
- **Rotate a leaked webhook secret** — Phase 1 (per-channel rotation steps)
- **Backfill a missed webhook** — Phase 1 (`scripts/replay-webhook.ts`)
- **Circuit-break LLM budget** — Phase 4 (how to temporarily raise + audit)
- **Revoke a paired device** — Phase 7 (`DELETE /api/app/devices/:id` + FCM deregister)
- **Recover from Supabase branch divergence** — Phase 0 addendum (drizzle-kit repair steps)

Each of these gets its own H2 when implemented.
