import Foundation
import AppKit
import Combine

/// Lightweight poller that watches running applications + frontmost
/// app to infer whether a meeting is active. Surfaces suggestions in
/// the menu bar; doesn't auto-start unless `autoStartForMeetings` is on.
@MainActor
final class MeetingDetector: ObservableObject {
    @Published private(set) var activeMeetingApp: String? = nil

    private var timer: Timer?

    /// Bundle IDs of apps we consider "meeting capable".
    private let knownMeetingApps: Set<String> = [
        "com.microsoft.teams",
        "com.microsoft.teams2",
        "us.zoom.xos",
        "com.google.Chrome",           // Meet runs in Chrome
        "com.apple.FaceTime",
        "com.webex.meetingmanager",
        "com.hnc.Discord",
        "com.tinyspeck.slackmacgap",   // Slack huddles
    ]

    init() {
        start()
    }

    deinit {
        timer?.invalidate()
    }

    private func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        refresh()
    }

    private func refresh() {
        let front = NSWorkspace.shared.frontmostApplication
        guard let bundleId = front?.bundleIdentifier else {
            activeMeetingApp = nil
            return
        }
        if knownMeetingApps.contains(bundleId) {
            activeMeetingApp = front?.localizedName
        } else {
            activeMeetingApp = nil
        }
    }
}
