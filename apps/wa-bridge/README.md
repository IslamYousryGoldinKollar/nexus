# @nexus/wa-bridge

WhatsApp **linked-device** bridge using Baileys. Runs as a long-lived
worker (NOT on Vercel — Vercel is serverless) and forwards every inbound
message to `POST /api/ingest/whatsapp-baileys` on the main Nexus web app.

## Why not the Meta Cloud API?

You keep your existing WhatsApp number without migrating it to Meta Cloud.
This uses WhatsApp's native "Linked Device" protocol (the same thing
WhatsApp Web uses). Trade-offs:

- ✅ Keep current number, no business verification
- ✅ Works with personal or business accounts
- ⚠️ Unofficial — use at your own risk (Meta can, in theory, disconnect
  the link). Follow a respectful send rate.
- ⚠️ Single session — one bridge instance per linked phone.

## How it works

```
 ┌──────────────────┐      Baileys WS       ┌──────────────┐
 │ WhatsApp phone   │◀─────────────────────▶│   wa-bridge  │
 └──────────────────┘   (linked device)     │   (Fly.io)   │
                                            └──────┬───────┘
          Supabase Storage (auth + media) ◀────────┤
                                                   │
                        HMAC POST /ingest/whatsapp-baileys
                                                   ▼
                                            ┌──────────────┐
                                            │ Nexus web    │
                                            │ (Vercel)     │
                                            └──────────────┘
```

- **Auth state** (Baileys multi-file credentials) is persisted to Supabase
  Storage so pod restarts never force re-pairing.
- **Media** is downloaded by the bridge, uploaded to Supabase Storage,
  then the API is told the storage key. The web app never handles raw
  binary, keeping serverless functions cold-start-fast.
- **HMAC** (`X-Nexus-Signature: sha256=…`) authenticates every request —
  share `WA_BRIDGE_HMAC_SECRET` between bridge and server.

## First-time setup

1. Create the Supabase bucket (once):
   ```sql
   -- In Supabase SQL Editor
   insert into storage.buckets (id, name, public)
   values ('nexus-attachments', 'nexus-attachments', false)
   on conflict (id) do nothing;
   ```

2. Generate a shared HMAC secret and install it on **both** sides:
   ```bash
   openssl rand -hex 32
   ```
   - Server (Vercel): `vercel env add WA_BRIDGE_HMAC_SECRET production`
   - Bridge (Fly):    `fly secrets set WA_BRIDGE_HMAC_SECRET=<hex>`

3. Deploy the bridge:
   ```bash
   cd apps/wa-bridge
   fly launch --no-deploy          # first time only; pick app name
   fly secrets set \
     WA_BRIDGE_NEXUS_URL=https://nexus-beta-coral.vercel.app \
     WA_BRIDGE_HMAC_SECRET=<hex> \
     SUPABASE_URL=https://clwvamwweevvmqyfqkzq.supabase.co \
     SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
     SUPABASE_STORAGE_BUCKET=nexus-attachments \
     WA_BRIDGE_PAIR_NUMBER=+2010xxxxxxxx    # optional, for pairing code
   fly deploy
   ```

4. Pair the device once:
   ```bash
   fly logs
   # You'll see either a QR code (scan in WhatsApp → Settings → Linked
   # Devices → Link a Device) or an 8-character pairing code
   # (WhatsApp → Linked Devices → Link with phone number).
   ```

## Running locally

```bash
cp .env.example .env          # fill in values
npm install
npm run dev                   # tsx watch; prints QR on first run
```

## Server-side endpoint

The bridge POSTs to `POST /api/ingest/whatsapp-baileys` with envelope:

```jsonc
{
  "source": "baileys",
  "device": "201234567890@s.whatsapp.net",
  "receivedAt": "2026-04-22T06:10:00.000Z",
  "messages": [
    {
      "id": "3EB0B5E1…",
      "from": "201234567890@s.whatsapp.net",
      "fromMe": false,
      "timestamp": 1745305800,
      "type": "text",
      "text": "Hey, can we move Friday's meeting to 3pm?"
    }
  ]
}
```

Headers:

- `content-type: application/json`
- `x-nexus-signature: sha256=<hex>` (HMAC of raw body with `WA_BRIDGE_HMAC_SECRET`)
- `user-agent: nexus-wa-bridge/<version>`

## Troubleshooting

| Symptom                              | Likely cause                                          |
| ------------------------------------ | ----------------------------------------------------- |
| `auth.hydrate.empty` then no QR      | Pairing number too new — wait 60s and redeploy        |
| `connection.close statusCode=401`    | Session logged out — re-pair                          |
| `forward.failed HTTP 401`            | HMAC secret mismatch between bridge & server          |
| Messages visible in WA, none ingested| Bridge not seeing `messages.upsert` notify — check DND|
