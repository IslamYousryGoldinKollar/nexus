import SwiftUI

/// The window that appears when the menu-bar icon is clicked.
struct MenuBarView: View {
    @ObservedObject var recorder: RecordingManager
    @ObservedObject var detector: MeetingDetector
    @ObservedObject var prefs: Preferences

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(recorder.isRecording ? .red : .secondary.opacity(0.3))
                    .frame(width: 8, height: 8)
                Text(recorder.isRecording ? "Recording…" : "Idle")
                    .font(.headline)
                Spacer()
                if recorder.isRecording {
                    Text(formatDuration(recorder.elapsedSeconds))
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }

            if let app = detector.activeMeetingApp {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .foregroundStyle(.yellow)
                    Text("Meeting detected in \(app)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let err = recorder.lastError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
            if let status = recorder.lastUpload, !recorder.isRecording {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Button {
                Task { await recorder.toggle() }
            } label: {
                HStack {
                    Image(systemName: recorder.isRecording ? "stop.circle.fill" : "record.circle.fill")
                    Text(recorder.isRecording ? "Stop & Upload" : "Start Recording")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(recorder.isRecording ? .red : .accentColor)
            .disabled(!prefs.isConfigured)

            if !prefs.isConfigured {
                Text("Open Settings to paste your Nexus URL + HMAC secret.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Divider()

            Button {
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            } label: {
                Label("Settings…", systemImage: "gear")
            }
            .buttonStyle(.plain)

            Button(role: .destructive) {
                NSApplication.shared.terminate(nil)
            } label: {
                Label("Quit", systemImage: "xmark.circle")
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .frame(width: 300)
    }

    private func formatDuration(_ s: TimeInterval) -> String {
        let total = Int(s)
        let h = total / 3600
        let m = (total % 3600) / 60
        let sec = total % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, sec)
            : String(format: "%02d:%02d", m, sec)
    }
}

/// Settings window — basic form-style inputs. Opened via the SwiftUI
/// `Settings { ... }` scene in `NexusRecorderApp`.
struct PreferencesView: View {
    @ObservedObject var prefs: Preferences

    var body: some View {
        Form {
            Section("Connection") {
                TextField("Nexus URL", text: $prefs.nexusUrl)
                    .textContentType(.URL)
                    .autocorrectionDisabled()
                SecureField("HMAC secret", text: $prefs.hmacSecret)
                TextField("Device label", text: $prefs.deviceLabel)
                Text("The HMAC secret is the same \(verbatim: "WA_BRIDGE_HMAC_SECRET") you installed on Vercel.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Capture") {
                Toggle("Also capture microphone", isOn: $prefs.includeMicrophone)
                Toggle("Auto-start when a meeting app is frontmost", isOn: $prefs.autoStartForMeetings)
                Text("\"Screen Recording\" permission is required for system audio. Grant it in System Settings → Privacy & Security → Screen & System Audio Recording.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
    }
}
