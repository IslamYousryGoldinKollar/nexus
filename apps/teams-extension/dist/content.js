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

// src/content.ts
var SEEN = /* @__PURE__ */ new Set();
var STARTED_AT = Date.now();
async function maybeIngest(node) {
  const messageId = node.getAttribute("data-mid") ?? node.getAttribute("data-message-id");
  if (!messageId) return;
  if (SEEN.has(messageId)) return;
  const tsRaw = node.getAttribute("data-ts");
  const ts = tsRaw ? Number(tsRaw) * (tsRaw.length > 11 ? 1 : 1e3) : Date.now();
  if (ts < STARTED_AT) {
    SEEN.add(messageId);
    return;
  }
  const cfg = await loadConfig();
  if (!cfg.enabled) return;
  const fromEl = node.querySelector('[data-tid="messageBodySender"]');
  const fromName = fromEl?.textContent?.trim();
  const fromUserId = fromEl?.getAttribute("data-userid") ?? fromName ?? "unknown";
  const direction = cfg.selfUserId && fromUserId === cfg.selfUserId ? "outbound" : "inbound";
  const textEl = node.querySelector('[data-tid="messageBodyContent"]');
  const text = textEl?.textContent?.trim() ?? void 0;
  const attEl = node.querySelector('a[data-tid="file-link"]');
  const attachmentUrl = attEl?.getAttribute("href") ?? void 0;
  const conversationId = document.querySelector('[data-tid="chat-pane-list"]')?.getAttribute("data-conversation-id") ?? location.pathname.split("/").pop() ?? "unknown";
  const payload = {
    messageId,
    fromUserId,
    fromName,
    conversationId,
    direction,
    text,
    occurredAt: new Date(ts).toISOString(),
    attachmentUrl,
    attachmentMime: attachmentUrl ? guessMime(attachmentUrl) : void 0
  };
  SEEN.add(messageId);
  chrome.runtime.sendMessage({ type: "INGEST", payload }).catch(() => {
  });
}
function guessMime(url) {
  const u = url.toLowerCase();
  if (u.includes(".mp4")) return "video/mp4";
  if (u.includes(".m4a")) return "audio/mp4";
  if (u.includes(".mp3")) return "audio/mpeg";
  if (u.includes(".wav")) return "audio/wav";
  if (u.includes(".png")) return "image/png";
  if (u.includes(".jpg") || u.includes(".jpeg")) return "image/jpeg";
  if (u.includes(".pdf")) return "application/pdf";
  return void 0;
}
var obs = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of Array.from(m.addedNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.matches("[data-mid], [data-message-id]")) void maybeIngest(node);
      node.querySelectorAll?.("[data-mid], [data-message-id]").forEach((n) => void maybeIngest(n));
    }
  }
});
function start() {
  obs.observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll("[data-mid], [data-message-id]").forEach((n) => void maybeIngest(n));
}
if (document.readyState === "complete") start();
else window.addEventListener("load", start);
//# sourceMappingURL=content.js.map
