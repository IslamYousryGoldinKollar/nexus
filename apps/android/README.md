# Nexus Android

Companion mobile app for the Nexus AI Chief-of-Staff system.

## Status

Phase 7+8 — **scaffold**. Source files are in place; building requires
opening this folder in Android Studio Hedgehog (or newer) which will
sync Gradle, download deps, and let you run on a device.

The scaffold demonstrates the complete architecture but is not a polished
app yet. The polishing work (theming, accessibility audit, offline UX,
crash reporting wiring, Play Store assets) is its own dedicated session.

## What it does (today)

- **Device pairing** via 6-char code from the web `/settings` page
- **Approvals queue**: poll `/api/approvals`, swipe to approve/reject,
  long-press to edit
- **FCM push notifications** for new approvals (notification taps deep-link
  into the queue)
- **Background phone-call upload** via folder watch (Phase 8 / Wave A'):
  watch the system call-recorder output directory, upload new files to
  `/api/ingest/phone` with WorkManager retries

## Architecture

```
MainActivity
  └─ NexusNavHost (Compose Navigation)
       ├─ PairingScreen         ← if no API key stored
       └─ ApprovalsScreen       ← otherwise
            └─ TaskCard (approve / edit / reject)

NexusApplication (Application class)
  ├─ NexusApi (Retrofit)
  ├─ SessionStore (EncryptedSharedPreferences)
  └─ WorkManager (UploadRecordingWorker)

NexusFcmService (extends FirebaseMessagingService)
  └─ on new token  →  PUT /api/devices/me/fcm-token
  └─ on data msg   →  show notification + refresh queue

RecordingObserverService (foreground service)
  └─ FileObserver on /storage/.../CallRecorder/
       └─ enqueue UploadRecordingWorker for each new file
```

## Build

```sh
# from this directory
./gradlew :app:assembleDebug
# install on connected device
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Required runtime config

A first-time install needs:

1. **Pairing code** from the web admin (`/settings`)
2. Storage permission grant (for call-recording observer)
3. Notification permission grant (Android 13+)
4. **`google-services.json`** in `app/` for FCM. Download from Firebase
   console for project `nexus-mobile`. Without this file the build
   skips FCM gracefully (notifications won't arrive).

## Phase 8 — call-recording strategy

Samsung S24 (and most Android 14+ devices) blocks third-party apps from
capturing the system mic during a call. Two strategies are scaffolded:

### Wave A' — Folder watcher (default, no special perms)

Observes the directory written to by an existing recorder app
(Cube ACR, Call Recorder Pro, Boldbeast, Samsung's own when it lands an
audio file). When a new file appears, upload it.

Configurable in `RecordingObserverService` — see the `WATCHED_DIRS`
constant. Add your recorder app's output folder.

### Wave B — Mic-only (fallback)

If the user has no third-party recorder, fall back to a foreground
service that records the device mic. Far-side audio will be missing
unless they use speakerphone — but at least their side is captured and
Whisper is decent at transcribing one-sided calls.

Wave B requires `RECORD_AUDIO` + `FOREGROUND_SERVICE_MICROPHONE`.

## Pending polish (future sessions)

- Material You theming + Nexus brand palette
- Pairing screen QR scanner (currently text entry only)
- Detailed task view + edit screen (current card is inline editor)
- Offline cache via Room
- Notification grouping
- Crash reporting (Sentry Android SDK)
- Play Store metadata + signing config
- Espresso UI tests
