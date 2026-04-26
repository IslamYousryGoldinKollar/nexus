import type { ExtMessage } from '../types';

/**
 * Offscreen document. Sole purpose: hold the tab-captured MediaStream
 * and run a MediaRecorder while the meeting is going.
 *
 * Lifecycle:
 *   - SW sends OFFSCREEN_START with a tabCapture streamId.
 *   - We resolve the streamId to a MediaStream via getUserMedia and
 *     start a MediaRecorder writing to in-memory chunks.
 *   - SW sends OFFSCREEN_STOP. We finish the recorder, concat the
 *     chunks into a Blob, and post OFFSCREEN_RESULT (base64-encoded
 *     bytes) back to the SW.
 *
 * We re-route the captured audio to a local AudioContext destination
 * so the user keeps hearing the meeting. Without this, tabCapture
 * silences the tab for the user as a side effect.
 */

interface ActiveRecording {
  recorder: MediaRecorder;
  chunks: Blob[];
  stream: MediaStream;
  audioCtx: AudioContext | null;
  startedAt: string;
}

let active: ActiveRecording | null = null;

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') {
    void start(msg.streamId, msg.startedAt)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        sendResponse({ ok: false, error: (e as Error).message });
        // Surface the failure to the SW so it can update status.
        void chrome.runtime.sendMessage({
          type: 'OFFSCREEN_RESULT',
          ok: false,
          error: (e as Error).message,
        } satisfies ExtMessage);
      });
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    void stop()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true;
  }
  return false;
});

async function start(streamId: string, startedAt: string): Promise<void> {
  if (active) throw new Error('already_recording');

  // Capture both sides of the conversation:
  //   - tabStream: remote participants (whatever Teams/Zoom/Meet plays
  //     through the tab, including WebRTC peer audio)
  //   - micStream: the user's own voice through the default mic
  //
  // We mix them with Web Audio so MediaRecorder gets a single track.
  // The first attempt at this extension only used tab audio, which on
  // Teams produced a 5 KB recording with the transcript "you" — Teams
  // routes peer audio through a path that tabCapture sometimes misses.
  // Adding the mic guarantees we at least capture the user's side.
  const tabStream = await (navigator.mediaDevices as MediaDevicesWithLegacy).getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as unknown as MediaTrackConstraints,
    video: false,
  });

  let micStream: MediaStream | null = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    // No mic permission / no mic — fall back to tab-only. Better to
    // record the meeting one-sided than fail the whole thing.
    console.warn('mic capture failed, recording tab only:', err);
  }

  // Mix tab + mic into a single MediaStream via AudioContext.
  // Also pipes tab audio back to the user's speakers — without this,
  // tabCapture silences the source tab and the meeting goes mute on
  // the user's end.
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();

  const tabSrc = audioCtx.createMediaStreamSource(tabStream);
  tabSrc.connect(dest);
  tabSrc.connect(audioCtx.destination); // monitor

  if (micStream) {
    const micSrc = audioCtx.createMediaStreamSource(micStream);
    micSrc.connect(dest);
    // Don't connect mic to destination — would create local echo.
  }

  const stream = dest.stream;

  // Prefer Opus-in-WebM — universally supported by Chrome's MediaRecorder
  // and Whisper accepts it directly.
  const mimeType = pickSupportedMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const used = recorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type: used });
    const endedAt = new Date().toISOString();
    const bytesBase64 = await blobToBase64(blob);
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_RESULT',
      ok: true,
      mimeType: used,
      bytesBase64,
      startedAt: active?.startedAt ?? startedAt,
      endedAt,
    } satisfies ExtMessage);
    teardown();
  };
  recorder.onerror = (e) => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_RESULT',
      ok: false,
      error: `recorder_error: ${(e as ErrorEvent).message ?? 'unknown'}`,
    } satisfies ExtMessage);
    teardown();
  };

  // 30s timeslice → if Chrome decides to flush mid-meeting, we still
  // have most of the audio in chunks rather than losing the lot.
  recorder.start(30_000);

  active = { recorder, chunks, stream, audioCtx, startedAt };
}

async function stop(): Promise<void> {
  if (!active) throw new Error('not_recording');
  // recorder.onstop fires asynchronously; result + teardown happen there.
  active.recorder.stop();
}

function teardown(): void {
  if (!active) return;
  for (const t of active.stream.getTracks()) t.stop();
  active.audioCtx?.close().catch(() => undefined);
  active = null;
}

function pickSupportedMime(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return undefined;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked encode — atob/btoa choke on >100 MB strings.
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/**
 * The `chrome.tabCapture`-via-getUserMedia API uses Chrome-specific
 * `mandatory: { chromeMediaSource, chromeMediaSourceId }` constraints
 * that aren't in lib.dom.d.ts. Cast through this shape to keep
 * @types/chrome's strictness without losing type-checking on the rest.
 */
type MediaDevicesWithLegacy = MediaDevices & {
  getUserMedia(constraints: unknown): Promise<MediaStream>;
};
