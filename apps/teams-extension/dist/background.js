// src/types.ts
var DEFAULT_CONFIG = {
  apiBaseUrl: "https://nexus.goldinkollar.com",
  apiKey: "",
  selfUserId: "",
  enabled: false
};

// src/storage.ts
var KEY = "nexus.teams.config";
async function loadConfig() {
  const data = await chrome.storage.sync.get(KEY);
  return { ...DEFAULT_CONFIG, ...data[KEY] ?? {} };
}

// src/background.ts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "INGEST") {
    sendResponse({ ok: false, error: "unknown_msg" });
    return false;
  }
  void handleIngest(msg.payload).then(sendResponse).catch((e) => {
    sendResponse({ ok: false, error: e.message });
  });
  return true;
});
async function handleIngest(payload) {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { ok: true };
  if (!cfg.apiBaseUrl || !cfg.apiKey) return { ok: false, error: "not_configured" };
  const res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, "")}/api/ingest/teams`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    return { ok: false, error: `http_${res.status}` };
  }
  return { ok: true };
}
if (chrome.alarms) {
  chrome.alarms.create("keepalive", { periodInMinutes: 4 });
  chrome.alarms.onAlarm.addListener(() => {
  });
}
//# sourceMappingURL=background.js.map
