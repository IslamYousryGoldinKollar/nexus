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

// src/popup/popup.ts
document.getElementById("open-options")?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
void (async () => {
  const cfg = await loadConfig();
  const status = document.getElementById("status");
  if (!status) return;
  if (!cfg.apiKey || !cfg.apiBaseUrl) {
    status.textContent = "Not configured.";
    status.className = "status off";
  } else if (!cfg.enabled) {
    status.textContent = "Forwarding off.";
    status.className = "status off";
  } else {
    status.textContent = `Forwarding to ${cfg.apiBaseUrl}`;
    status.className = "status";
  }
})();
//# sourceMappingURL=popup.js.map
