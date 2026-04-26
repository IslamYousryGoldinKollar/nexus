import { loadConfig } from './storage';
import type { ExtMessage } from './types';

/**
 * MV3 service worker. Coordinates the meeting-recording flow:
 *
 *   popup → SW (START_RECORDING with active tabId)
 *     → SW asks tabCapture for a streamId for that tab
 *     → SW makes sure an offscreen document exists
 *     → SW forwards streamId to offscreen (OFFSCREEN_START)
 *     → offscreen records via getUserMedia + MediaRecorder
 *
 *   popup → SW (STOP_RECORDING)
 *     → SW forwards to offscreen (OFFSCREEN_STOP)
 *     → offscreen finalizes Blob, base64-encodes, and posts back
 *       (OFFSCREEN_RESULT)
 *     → SW uploads bytes to /api/ingest/meeting with Bearer auth
 *
 * Status (recording / duration / uploading / lastError / lastInteractionId)
 * lives in this SW's memory and is fetched by the popup on open via
 * GET_STATUS. The SW gets torn down when idle, but the chrome.alarms
 * keepalive holds it for the recording duration.
 */

interface State {
  recording: boolean;
  startedAtMs: number | null;
  uploading: boolean;
  lastError?: string;
  lastInteractionId?: string;
}

const state: State = {
  recording: false,
  startedAtMs: null,
  uploading: false,
};

const OFFSCREEN_URL = 'offscreen.html';

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  if (msg.type === 'GET_STATUS') {
    sendResponse(snapshotStatus());
    return false;
  }
  if (msg.type === 'START_RECORDING') {
    void startRecording(msg.tabId).then(sendResponse).catch((e) => {
      state.lastError = (e as Error).message;
      sendResponse({ ok: false, error: state.lastError });
    });
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    void stopRecording().then(sendResponse).catch((e) => {
      state.lastError = (e as Error).message;
      sendResponse({ ok: false, error: state.lastError });
    });
    return true;
  }
  if (msg.type === 'OFFSCREEN_RESULT') {
    void handleOffscreenResult(msg).catch((e) => {
      state.lastError = (e as Error).message;
    });
    return false;
  }
  return false;
});

function snapshotStatus(): Extract<ExtMessage, { type: 'STATUS' }> {
  return {
    type: 'STATUS',
    recording: state.recording,
    durationMs: state.startedAtMs ? Date.now() - state.startedAtMs : 0,
    uploading: state.uploading,
    lastError: state.lastError,
    lastInteractionId: state.lastInteractionId,
  };
}

async function startRecording(tabId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state.recording) return { ok: false, error: 'already_recording' };
  state.lastError = undefined;
  state.lastInteractionId = undefined;

  // tabCapture.getMediaStreamId returns an opaque id we can hand to
  // getUserMedia in any extension page (offscreen) to obtain the actual
  // MediaStream for the targeted tab.
  const streamId = await new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'getMediaStreamId failed'));
      } else if (!id) {
        reject(new Error('getMediaStreamId returned empty'));
      } else {
        resolve(id);
      }
    });
  });

  await ensureOffscreen();

  const startedAt = new Date().toISOString();
  state.recording = true;
  state.startedAtMs = Date.now();

  await sendToOffscreen({ type: 'OFFSCREEN_START', streamId, startedAt });
  return { ok: true };
}

async function stopRecording(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!state.recording) return { ok: false, error: 'not_recording' };
  state.uploading = true; // assume there'll be bytes coming back
  await sendToOffscreen({ type: 'OFFSCREEN_STOP' });
  state.recording = false;
  state.startedAtMs = null;
  return { ok: true };
}

async function handleOffscreenResult(
  msg: Extract<ExtMessage, { type: 'OFFSCREEN_RESULT' }>,
): Promise<void> {
  if (!msg.ok) {
    state.uploading = false;
    state.lastError = msg.error;
    await closeOffscreen();
    return;
  }
  try {
    await uploadMeeting(msg);
  } finally {
    state.uploading = false;
    await closeOffscreen();
  }
}

async function uploadMeeting(
  msg: Extract<ExtMessage, { type: 'OFFSCREEN_RESULT'; ok: true }>,
): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.apiBaseUrl || !cfg.apiKey) {
    state.lastError = 'not_configured';
    return;
  }

  const bytes = base64ToBytes(msg.bytesBase64);
  if (bytes.byteLength < 1024) {
    state.lastError = 'recording_too_short';
    return;
  }

  const filename = `meeting-${msg.startedAt.replace(/[:.]/g, '-')}.${extFromMime(msg.mimeType)}`;
  const fd = new FormData();
  // Cast through ArrayBuffer to satisfy lib.dom strictness — TS's
  // Uint8Array<ArrayBufferLike> isn't directly assignable to BlobPart.
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: msg.mimeType });
  fd.append('audio', blob, filename);
  fd.append('startedAt', msg.startedAt);
  fd.append('endedAt', msg.endedAt);
  fd.append('device', `chrome-${navigator.userAgent.split(' ').slice(-2).join(' ')}`);
  fd.append('source', 'chrome-extension');

  const res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, '')}/api/ingest/meeting`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    state.lastError = `http_${res.status}: ${body.slice(0, 200)}`;
    return;
  }
  const json = (await res.json().catch(() => ({}))) as { interactionId?: string };
  state.lastInteractionId = json.interactionId;
}

// ---- offscreen lifecycle -------------------------------------------------

async function ensureOffscreen(): Promise<void> {
  // chrome.offscreen.hasDocument is the canonical existence check.
  // Older Chrome versions might not have it; fall back to getContexts.
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    if (await chrome.offscreen.hasDocument()) return;
  } else {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (ctxs.length > 0) return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Recording meeting audio for the Nexus pipeline.',
  });
}

async function closeOffscreen(): Promise<void> {
  try {
    if (typeof chrome.offscreen?.hasDocument === 'function') {
      if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
      }
    } else {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    /* already closed */
  }
}

async function sendToOffscreen(msg: ExtMessage): Promise<void> {
  // Allow the offscreen document a moment to attach its message listener.
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.runtime.sendMessage(msg);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('offscreen unreachable');
}

// ---- helpers -------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extFromMime(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'bin';
}

// Keep the SW alive while a recording is in flight. Without this Chrome
// tears the worker down after ~30s idle and cancels the recording.
if (chrome.alarms) {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => {
    /* no-op; the alarm fire keeps the SW resident */
  });
}
