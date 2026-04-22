import Foundation
import AVFoundation
import ScreenCaptureKit
import Combine

/// Captures **system audio** (and optionally the microphone) to an m4a
/// file using ScreenCaptureKit + AVAssetWriter.
///
/// Why ScreenCaptureKit and not BlackHole/Loopback?
///   macOS 14+ ships first-party system-audio capture through SCK. No
///   driver installation, no kext, no audio-device gymnastics. The user
///   grants "Screen Recording" permission once (it's a misnomer: the
///   same permission unlocks audio only when `capturesAudio = true`).
///
/// We deliberately do NOT capture video frames — the stream is audio-
/// only, which keeps CPU use negligible and makes the permission
/// prompt's scope match what we actually do.
@MainActor
final class RecordingManager: NSObject, ObservableObject, @preconcurrency SCStreamOutput, @preconcurrency SCStreamDelegate {
    @Published var isRecording = false
    @Published var elapsedSeconds: TimeInterval = 0
    @Published var lastError: String?
    @Published var lastUpload: String?

    private var stream: SCStream?
    private var assetWriter: AVAssetWriter?
    private var audioInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private var micEngine: AVAudioEngine?
    private var startedAt: Date?
    private var currentOutputUrl: URL?
    private var elapsedTimer: Timer?

    private let sampleQueue = DispatchQueue(label: "nexus.recorder.samples", qos: .userInitiated)

    // MARK: - Public API

    func toggle() async {
        if isRecording {
            await stop()
        } else {
            await start()
        }
    }

    func start() async {
        guard !isRecording else { return }
        lastError = nil
        do {
            try await startStream()
            startedAt = Date()
            isRecording = true
            startTicker()
        } catch {
            lastError = "start failed: \(error.localizedDescription)"
            await teardown()
        }
    }

    func stop() async {
        guard isRecording else { return }
        stopTicker()
        isRecording = false
        do {
            let url = try await finalize()
            lastUpload = "uploading…"
            Task.detached { [weak self] in
                guard let self else { return }
                do {
                    let start = await self.startedAt ?? Date()
                    try await Uploader.shared.upload(
                        fileUrl: url,
                        startedAt: start,
                        endedAt: Date(),
                        deviceLabel: Preferences.shared.deviceLabel
                    )
                    await MainActor.run { self.lastUpload = "uploaded ✓" }
                } catch {
                    await MainActor.run {
                        self.lastUpload = "upload failed: \(error.localizedDescription)"
                    }
                }
            }
        } catch {
            lastError = "finalize failed: \(error.localizedDescription)"
        }
        await teardown()
    }

    // MARK: - Stream setup

    private func startStream() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )
        guard let display = content.displays.first else {
            throw RecError("no display available for SCContentFilter")
        }
        // Audio-only: filter targets the display but we disable video
        // frames in the stream configuration.
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)   // effectively "no video"
        cfg.width = 2     // SCStream requires non-zero video config
        cfg.height = 2

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        self.stream = s

        try await setupWriter(sampleRate: 48_000, channels: 2)
        try await s.startCapture()

        if Preferences.shared.includeMicrophone {
            try startMicTap()
        }
    }

    private func setupWriter(sampleRate: Double, channels: Int) async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("NexusRecorder", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fname = "meeting-\(Int(Date().timeIntervalSince1970)).m4a"
        let outUrl = dir.appendingPathComponent(fname)
        try? FileManager.default.removeItem(at: outUrl)
        currentOutputUrl = outUrl

        let writer = try AVAssetWriter(outputURL: outUrl, fileType: .m4a)

        // AAC-encoded mixdown — Whisper accepts m4a natively.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVEncoderBitRateKey: 96_000,
        ]
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        if writer.canAdd(input) {
            writer.add(input)
        }
        self.assetWriter = writer
        self.audioInput = input

        // Second track for mic (mixed at playback/transcode time by Whisper — it
        // accepts single-track; we pre-mix via AVAudioEngine instead).
    }

    // MARK: - Mic tap (mixed into system audio track via AVAudioEngine)

    private func startMicTap() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, when in
            guard let self else { return }
            // Convert to CMSampleBuffer and append to the same audio input.
            // For MVP simplicity, we append alongside system audio; the
            // m4a gets a mono-ish mix. A proper submix node lives in a
            // follow-up PR.
            if let sample = buffer.toCMSampleBuffer(presentationTime: when.hostTime) {
                Task { @MainActor [weak self] in
                    self?.appendSample(sample)
                }
            }
        }
        try engine.start()
        self.micEngine = engine
    }

    // MARK: - SCStreamOutput

    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, CMSampleBufferIsValid(sampleBuffer) else { return }
        Task { @MainActor [weak self] in
            self?.appendSample(sampleBuffer)
        }
    }

    private func appendSample(_ sampleBuffer: CMSampleBuffer) {
        guard let writer = assetWriter, let input = audioInput else { return }
        if writer.status == .unknown {
            writer.startWriting()
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        }
        if writer.status == .writing, input.isReadyForMoreMediaData {
            input.append(sampleBuffer)
        }
    }

    // MARK: - SCStreamDelegate

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.lastError = "stream stopped: \(error.localizedDescription)"
            self?.isRecording = false
        }
    }

    // MARK: - Finalize + teardown

    private func finalize() async throws -> URL {
        micEngine?.inputNode.removeTap(onBus: 0)
        micEngine?.stop()
        try? await stream?.stopCapture()
        audioInput?.markAsFinished()

        guard let writer = assetWriter, let url = currentOutputUrl else {
            throw RecError("finalize called with no writer")
        }
        await writer.finishWriting()
        return url
    }

    private func teardown() async {
        stream = nil
        assetWriter = nil
        audioInput = nil
        micEngine = nil
    }

    // MARK: - Ticker

    private func startTicker() {
        elapsedSeconds = 0
        elapsedTimer?.invalidate()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let start = self?.startedAt else { return }
                self?.elapsedSeconds = Date().timeIntervalSince(start)
            }
        }
    }

    private func stopTicker() {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
    }
}

private struct RecError: Error, LocalizedError {
    let message: String
    init(_ m: String) { self.message = m }
    var errorDescription: String? { message }
}

// MARK: - AVAudioPCMBuffer → CMSampleBuffer helper

private extension AVAudioPCMBuffer {
    func toCMSampleBuffer(presentationTime: UInt64) -> CMSampleBuffer? {
        var asbd = self.format.streamDescription.pointee
        var formatDesc: CMAudioFormatDescription?
        let status = CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            asbd: &asbd,
            layoutSize: 0,
            layout: nil,
            magicCookieSize: 0,
            magicCookie: nil,
            extensions: nil,
            formatDescriptionOut: &formatDesc
        )
        guard status == noErr, let fd = formatDesc else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: Int32(asbd.mSampleRate)),
            presentationTimeStamp: CMTimeMake(value: Int64(presentationTime), timescale: Int32(asbd.mSampleRate)),
            decodeTimeStamp: .invalid
        )
        var sb: CMSampleBuffer?
        let frameCount = CMItemCount(self.frameLength)
        _ = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault,
            dataBuffer: nil,
            dataReady: false,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: fd,
            sampleCount: frameCount,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 0,
            sampleSizeArray: nil,
            sampleBufferOut: &sb
        )
        guard let sampleBuffer = sb else { return nil }
        _ = CMSampleBufferSetDataBufferFromAudioBufferList(
            sampleBuffer,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            bufferList: self.audioBufferList
        )
        return sampleBuffer
    }
}
