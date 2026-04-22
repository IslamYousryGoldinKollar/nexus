import Foundation
import Combine

/// App-wide preferences persisted to UserDefaults.
/// The HMAC secret is stored in Keychain-like semantics for a future
/// hardening pass — MVP uses UserDefaults for speed.
final class Preferences: ObservableObject {
    static let shared = Preferences()

    @Published var nexusUrl: String {
        didSet { UserDefaults.standard.set(nexusUrl, forKey: Keys.nexusUrl) }
    }
    @Published var hmacSecret: String {
        didSet { UserDefaults.standard.set(hmacSecret, forKey: Keys.hmacSecret) }
    }
    @Published var deviceLabel: String {
        didSet { UserDefaults.standard.set(deviceLabel, forKey: Keys.deviceLabel) }
    }
    @Published var includeMicrophone: Bool {
        didSet { UserDefaults.standard.set(includeMicrophone, forKey: Keys.includeMic) }
    }
    @Published var autoStartForMeetings: Bool {
        didSet { UserDefaults.standard.set(autoStartForMeetings, forKey: Keys.autoStart) }
    }

    private enum Keys {
        static let nexusUrl = "nexus.url"
        static let hmacSecret = "nexus.hmac"
        static let deviceLabel = "nexus.label"
        static let includeMic = "nexus.mic"
        static let autoStart = "nexus.autoStart"
    }

    private init() {
        let d = UserDefaults.standard
        self.nexusUrl = d.string(forKey: Keys.nexusUrl) ?? "https://nexus-beta-coral.vercel.app"
        self.hmacSecret = d.string(forKey: Keys.hmacSecret) ?? ""
        self.deviceLabel = d.string(forKey: Keys.deviceLabel) ?? (Host.current().localizedName ?? "mac")
        self.includeMicrophone = d.object(forKey: Keys.includeMic) as? Bool ?? true
        self.autoStartForMeetings = d.object(forKey: Keys.autoStart) as? Bool ?? false
    }

    var isConfigured: Bool {
        !nexusUrl.isEmpty && !hmacSecret.isEmpty
    }
}
