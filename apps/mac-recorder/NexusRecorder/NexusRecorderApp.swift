import SwiftUI

/// NexusRecorder — menu-bar macOS app that captures meeting audio
/// (system + microphone) via ScreenCaptureKit and uploads to Nexus.
///
/// Architecture:
///   - `RecordingManager`: wraps SCStream + AVAssetWriter, emits mixed
///     AAC/m4a to disk.
///   - `MeetingDetector`: polls running apps; surfaces a suggestion in
///     the menu when Teams/Zoom/Meet is foregrounded.
///   - `Uploader`: HMAC-signs + streams the finished m4a to
///     `$NEXUS_URL/api/ingest/meeting`.
///   - `Preferences`: UserDefaults-backed settings (URL, secret, label).
@main
struct NexusRecorderApp: App {
    @StateObject private var recorder = RecordingManager()
    @StateObject private var detector = MeetingDetector()
    @StateObject private var prefs = Preferences.shared

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(recorder: recorder, detector: detector, prefs: prefs)
        } label: {
            Image(systemName: recorder.isRecording ? "record.circle.fill" : "record.circle")
                .symbolRenderingMode(.hierarchical)
                .foregroundColor(recorder.isRecording ? .red : .primary)
        }
        .menuBarExtraStyle(.window)

        Settings {
            PreferencesView(prefs: prefs)
                .frame(width: 460)
        }
    }
}
