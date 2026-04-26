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

// src/popup/popup.ts
var els = {
  state: document.getElementById("state"),
  timer: document.getElementById("timer"),
  action: document.getElementById("action"),
  msg: document.getElementById("msg")
};
document.getElementById("open-options")?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
document.getElementById("open-tasks")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const cfg = await loadConfig();
  if (cfg.apiBaseUrl) {
    void chrome.tabs.create({ url: `${cfg.apiBaseUrl.replace(/\/$/, "")}/approvals` });
  }
});
els.action.addEventListener("click", () => {
  void onActionClick();
});
async function onActionClick() {
  els.action.disabled = true;
  try {
    const status = await getStatus();
    if (status.recording) {
      await sendMessage({ type: "STOP_RECORDING" });
      els.msg.innerHTML = '<div class="ok">Stopping\u2026 uploading audio.</div>';
    } else {
      const cfg = await loadConfig();
      if (!cfg.apiBaseUrl || !cfg.apiKey) {
        els.msg.innerHTML = '<div class="err">Configure Base URL + API key in Options first.</div>';
        return;
      }
      const tab = await activeTab();
      if (!tab?.id) {
        els.msg.innerHTML = '<div class="err">No active tab found.</div>';
        return;
      }
      const result = await sendMessage({
        type: "START_RECORDING",
        tabId: tab.id
      });
      if (!result?.ok) {
        els.msg.innerHTML = `<div class="err">${escape(result?.error ?? "failed")}</div>`;
        return;
      }
      els.msg.innerHTML = "";
    }
  } finally {
    els.action.disabled = false;
    await render();
  }
}
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}
async function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}
async function getStatus() {
  const fallback = {
    type: "STATUS",
    recording: false,
    durationMs: 0,
    uploading: false
  };
  const r = await sendMessage({
    type: "GET_STATUS"
  });
  return r ?? fallback;
}
async function render() {
  const status = await getStatus();
  if (status.recording) {
    els.state.textContent = "\u25CF Recording";
    els.state.className = "pill live";
    els.timer.textContent = formatDuration(status.durationMs);
    els.action.textContent = "Stop & upload";
    els.action.className = "stop";
    return;
  }
  if (status.uploading) {
    els.state.textContent = "\u2191 Uploading";
    els.state.className = "pill uploading";
    els.timer.textContent = "";
    els.action.textContent = "Start recording";
    els.action.className = "start";
    els.action.disabled = true;
    return;
  }
  els.action.disabled = false;
  els.action.textContent = "Start recording";
  els.action.className = "start";
  els.timer.textContent = "";
  if (status.lastError) {
    els.state.textContent = "\u26A0 Error";
    els.state.className = "pill err";
    els.msg.innerHTML = `<div class="err">${escape(status.lastError)}</div>`;
    return;
  }
  if (status.lastInteractionId) {
    els.state.textContent = "\u2713 Uploaded";
    els.state.className = "pill ok";
    els.msg.innerHTML = `<div class="ok">Sent \u2014 interaction <code>${escape(
      status.lastInteractionId.slice(0, 8)
    )}</code>. Transcription + reasoning kick in within ~2 min.</div>`;
    return;
  }
  els.state.textContent = "Idle";
  els.state.className = "pill idle";
}
function formatDuration(ms) {
  const s = Math.floor(ms / 1e3);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
function escape(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
void render();
setInterval(() => void render(), 500);
//# sourceMappingURL=popup.js.map
