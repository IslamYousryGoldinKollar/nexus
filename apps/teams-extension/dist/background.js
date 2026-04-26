// src/types.ts
var DEFAULT_CONFIG = {
  apiBaseUrl: "https://nexus-beta-coral.vercel.app",
  apiKey: "",
  enabled: true
};

// src/storage.ts
var KEY = "nexus.teams.config";
async function loadConfig() {
  const data = await chrome.storage.sync.get(KEY);
  return { ...DEFAULT_CONFIG, ...data[KEY] ?? {} };
}

// src/background.ts
var state = {
  recording: false,
  startedAtMs: null,
  uploading: false
};
var OFFSCREEN_URL = "offscreen.html";
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_STATUS") {
    sendResponse(snapshotStatus());
    return false;
  }
  if (msg.type === "START_RECORDING") {
    void startRecording(msg.tabId).then(sendResponse).catch((e) => {
      state.lastError = e.message;
      sendResponse({ ok: false, error: state.lastError });
    });
    return true;
  }
  if (msg.type === "STOP_RECORDING") {
    void stopRecording().then(sendResponse).catch((e) => {
      state.lastError = e.message;
      sendResponse({ ok: false, error: state.lastError });
    });
    return true;
  }
  if (msg.type === "OFFSCREEN_RESULT") {
    void handleOffscreenResult(msg).catch((e) => {
      state.lastError = e.message;
    });
    return false;
  }
  return false;
});
function snapshotStatus() {
  return {
    type: "STATUS",
    recording: state.recording,
    durationMs: state.startedAtMs ? Date.now() - state.startedAtMs : 0,
    uploading: state.uploading,
    lastError: state.lastError,
    lastInteractionId: state.lastInteractionId
  };
}
async function startRecording(tabId) {
  if (state.recording) return { ok: false, error: "already_recording" };
  state.lastError = void 0;
  state.lastInteractionId = void 0;
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? "getMediaStreamId failed"));
      } else if (!id) {
        reject(new Error("getMediaStreamId returned empty"));
      } else {
        resolve(id);
      }
    });
  });
  await ensureOffscreen();
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  state.recording = true;
  state.startedAtMs = Date.now();
  await sendToOffscreen({ type: "OFFSCREEN_START", streamId, startedAt });
  return { ok: true };
}
async function stopRecording() {
  if (!state.recording) return { ok: false, error: "not_recording" };
  state.uploading = true;
  await sendToOffscreen({ type: "OFFSCREEN_STOP" });
  state.recording = false;
  state.startedAtMs = null;
  return { ok: true };
}
async function handleOffscreenResult(msg) {
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
async function uploadMeeting(msg) {
  const cfg = await loadConfig();
  if (!cfg.apiBaseUrl || !cfg.apiKey) {
    state.lastError = "not_configured";
    return;
  }
  const bytes = base64ToBytes(msg.bytesBase64);
  if (bytes.byteLength < 1024) {
    state.lastError = "recording_too_short";
    return;
  }
  const filename = `meeting-${msg.startedAt.replace(/[:.]/g, "-")}.${extFromMime(msg.mimeType)}`;
  const fd = new FormData();
  const blob = new Blob([bytes.buffer], { type: msg.mimeType });
  fd.append("audio", blob, filename);
  fd.append("startedAt", msg.startedAt);
  fd.append("endedAt", msg.endedAt);
  fd.append("device", `chrome-${navigator.userAgent.split(" ").slice(-2).join(" ")}`);
  fd.append("source", "chrome-extension");
  const res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, "")}/api/ingest/meeting`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: fd
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    state.lastError = `http_${res.status}: ${body.slice(0, 200)}`;
    return;
  }
  const json = await res.json().catch(() => ({}));
  state.lastInteractionId = json.interactionId;
}
async function ensureOffscreen() {
  if (typeof chrome.offscreen?.hasDocument === "function") {
    if (await chrome.offscreen.hasDocument()) return;
  } else {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    });
    if (ctxs.length > 0) return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Recording meeting audio for the Nexus pipeline."
  });
}
async function closeOffscreen() {
  try {
    if (typeof chrome.offscreen?.hasDocument === "function") {
      if (await chrome.offscreen.hasDocument()) {
        await chrome.offscreen.closeDocument();
      }
    } else {
      await chrome.offscreen.closeDocument();
    }
  } catch {
  }
}
async function sendToOffscreen(msg) {
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.runtime.sendMessage(msg);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("offscreen unreachable");
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function extFromMime(mime) {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "bin";
}
if (chrome.alarms) {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(() => {
  });
}
//# sourceMappingURL=background.js.map
