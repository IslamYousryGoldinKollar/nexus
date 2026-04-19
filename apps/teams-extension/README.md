# Nexus Teams Bridge (Chrome Extension)

MV3 extension that watches `teams.microsoft.com` and forwards DMs to
your Nexus instance via `POST /api/ingest/teams`.

## Status

Phase 10 — **scaffold**. The pipeline is wired end-to-end (content
script → background SW → /api/ingest/teams → DB → reasoning), but the
content-script DOM selectors will need tuning each time Teams ships a
significant UI change.

## Build

```sh
pnpm install
pnpm --filter @nexus/teams-extension build
# Load chrome://extensions → Developer mode → Load unpacked → dist/
```

## Configure

After loading the unpacked extension, right-click → Options:

- **Base URL** — your Nexus deployment, e.g. `https://nexus.goldinkollar.com`
- **API key** — `TEAMS_INGEST_API_KEY` from the Vercel env vars
- **Self user id** — your Teams user id, used to label outbound vs inbound
- **Enabled** — master switch

## What gets forwarded

For each new message DOM node observed in the Teams chat pane:

| Field | Source |
|---|---|
| `messageId` | `data-mid` or `data-message-id` |
| `fromUserId` | `[data-tid="messageBodySender"]@data-userid` |
| `fromName` | innerText of sender element |
| `text` | innerText of `[data-tid="messageBodyContent"]` |
| `attachmentUrl` | `a[data-tid="file-link"]@href` (if any) |
| `direction` | `outbound` if `fromUserId === selfUserId`, else `inbound` |
| `occurredAt` | `data-ts` if present, else `Date.now()` |

Server-side de-duplication via `UNIQUE(channel, source_message_id)`.

## Caveats / known gaps

- Channel posts (not DMs) intentionally out of scope for v1.
- Teams blob URLs for attachments require an auth header the server
  doesn't have today. Phase 10+ adds Microsoft Graph token relay for
  attachment fetch.
- Selectors lean on `data-tid` / `data-mid` because they're more stable
  than class names; if Teams renames them, update `src/content.ts`.
- No tests yet — DOM scraping is hard to test in Vitest. Manual QA loop:
  load the unpacked extension, open Teams, send yourself a message,
  confirm the row in the Sessions admin view.
