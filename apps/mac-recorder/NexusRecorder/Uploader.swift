import Foundation
import CommonCrypto

/// HMAC-signed multipart uploader for finished m4a files.
///
/// Contract with `POST /api/ingest/meeting`:
///   - Method: POST, Content-Type: multipart/form-data
///   - Fields: `audio` (file), `startedAt`, `endedAt`, `device`
///   - Header: `X-Nexus-Signature: sha256=<hex>` — HMAC of the raw
///     multipart body using `WA_BRIDGE_HMAC_SECRET` (reused so we
///     don't sprawl secrets across services).
///
/// The signature covers the *entire* body bytes (headers excluded)
/// because multipart boundaries are deterministic and we want a single
/// round-trip without streaming auth.
actor Uploader {
    static let shared = Uploader()

    enum UploadError: LocalizedError {
        case notConfigured
        case badResponse(Int, String)
        case signingFailed
        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Preferences missing (URL or HMAC secret)"
            case .badResponse(let code, let body): return "HTTP \(code): \(body)"
            case .signingFailed: return "HMAC signing failed"
            }
        }
    }

    func upload(fileUrl: URL, startedAt: Date, endedAt: Date, deviceLabel: String) async throws {
        let prefs = await MainActor.run { Preferences.shared }
        guard prefs.isConfigured else { throw UploadError.notConfigured }

        let url = URL(string: "\(prefs.nexusUrl)/api/ingest/meeting")!
        let boundary = "nexus-\(UUID().uuidString)"
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let audio = try Data(contentsOf: fileUrl)

        var body = Data()
        func appendField(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            body.append("\(value)\r\n")
        }
        appendField("startedAt", iso.string(from: startedAt))
        appendField("endedAt", iso.string(from: endedAt))
        appendField("device", deviceLabel)
        appendField("source", "macos-recorder")

        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"\(fileUrl.lastPathComponent)\"\r\n")
        body.append("Content-Type: audio/mp4\r\n\r\n")
        body.append(audio)
        body.append("\r\n")
        body.append("--\(boundary)--\r\n")

        let signature = try hmacSHA256Hex(key: prefs.hmacSecret, data: body)

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue("sha256=\(signature)", forHTTPHeaderField: "X-Nexus-Signature")
        req.setValue("nexus-mac-recorder/0.1", forHTTPHeaderField: "User-Agent")
        req.httpBody = body
        // 5-minute timeout for long meetings
        req.timeoutInterval = 300

        let (respData, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw UploadError.badResponse(-1, "no HTTPURLResponse")
        }
        if !(200..<300).contains(http.statusCode) {
            let body = String(data: respData, encoding: .utf8) ?? ""
            throw UploadError.badResponse(http.statusCode, String(body.prefix(200)))
        }
        // Cleanup the temp file on success.
        try? FileManager.default.removeItem(at: fileUrl)
    }

    private func hmacSHA256Hex(key: String, data: Data) throws -> String {
        guard let keyBytes = key.data(using: .utf8) else { throw UploadError.signingFailed }
        var mac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        keyBytes.withUnsafeBytes { keyPtr in
            data.withUnsafeBytes { dataPtr in
                CCHmac(
                    CCHmacAlgorithm(kCCHmacAlgSHA256),
                    keyPtr.baseAddress, keyBytes.count,
                    dataPtr.baseAddress, data.count,
                    &mac
                )
            }
        }
        return mac.map { String(format: "%02x", $0) }.joined()
    }
}

private extension Data {
    mutating func append(_ s: String) {
        if let d = s.data(using: .utf8) { append(d) }
    }
}
