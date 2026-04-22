# NexusRecorder — macOS meeting recorder

A tiny menu-bar macOS app that captures **system audio** (plus your
microphone, optionally) during any meeting — Teams, Zoom, Google Meet,
FaceTime, Slack huddles, Discord, anything — and uploads the recording
to Nexus for Whisper transcription and Claude summarization.

## How it works

- Uses Apple's **ScreenCaptureKit** (`capturesAudio = true`) to grab the
  system audio mix without any virtual audio driver.
- Mixes in your microphone via `AVAudioEngine` (toggle in Settings).
- Writes AAC/m4a via `AVAssetWriter`.
- On stop, HMAC-signs the file and POSTs it to
  `$NEXUS_URL/api/ingest/meeting`.

No audio ever touches Apple servers; nothing is uploaded until you
press Stop.

## First-time build

You need **Xcode 15.3+** (free from the App Store; macOS 14+).

```bash
# 1. Install xcodegen (one line, generates the .xcodeproj)
brew install xcodegen

# 2. Generate the project
cd apps/mac-recorder
xcodegen

# 3. Open in Xcode
open NexusRecorder.xcodeproj

# 4. In Xcode: Product → Run (⌘R). First run will prompt for
#    - Screen Recording permission  (required for system audio)
#    - Microphone permission         (only if "Include mic" is on)
```

After the first successful build, drag `NexusRecorder.app` out of
`~/Library/Developer/Xcode/DerivedData/NexusRecorder-*/Build/Products/Debug/`
into `/Applications/` — or export a Release archive.

## Settings

Click the menu bar icon → **Settings…**

| Field              | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| Nexus URL          | `https://nexus-beta-coral.vercel.app`                        |
| HMAC secret        | The same `WA_BRIDGE_HMAC_SECRET` you installed on Vercel     |
| Device label       | Freeform — shows up in the admin as "Captured from `<label>`"|
| Capture microphone | ON = both sides of the call; OFF = just far-side             |
| Auto-start         | ON = recording starts when Teams/Zoom comes to front (MVP polls every 3s) |

## Recording a meeting

1. Click the menu bar icon → **Start Recording**
2. Hold the meeting normally. The icon turns **red** while recording.
3. Click → **Stop & Upload**. You'll see "uploading…" then "uploaded ✓".

The file lands in Supabase Storage under `meeting/yyyy/mm/dd/<hash>.m4a`;
Nexus creates an interaction with `content_type=meeting`, runs Whisper
in the background, and surfaces a session for you on Telegram for
approval.

## Auto-launch at login

System Settings → General → Login Items → "+". Pick `NexusRecorder.app`.

## Troubleshooting

| Symptom                                         | Fix                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| "no display available for SCContentFilter"      | Grant Screen Recording permission, then relaunch the app            |
| Recording is silent                             | The app whose audio you want isn't running; try speaker-test first  |
| Uploads fail with HTTP 401                      | HMAC secret mismatch — re-paste from Vercel                         |
| m4a saved but no interaction appears in admin   | Check `vercel logs --prod`; look for `wa_baileys` or `meeting` logs |

## Privacy model

- **No telemetry**. The app calls your Nexus URL and nothing else.
- **Local-first**. The m4a is written to `~/Library/Caches` until
  upload succeeds; on a successful upload it's deleted from disk.
- **No video**. We pass a 2×2 dummy video config (SCStream requires
  non-zero dimensions) and never read frames.
