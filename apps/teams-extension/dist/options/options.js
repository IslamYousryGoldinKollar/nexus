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
async function saveConfig(cfg) {
  await chrome.storage.sync.set({ [KEY]: cfg });
}

// src/options/options.ts
var $ = (id) => document.getElementById(id);
async function bootstrap() {
  const cfg = await loadConfig();
  $("apiBaseUrl").value = cfg.apiBaseUrl;
  $("apiKey").value = cfg.apiKey;
  $("selfUserId").value = cfg.selfUserId;
  $("enabled").checked = cfg.enabled;
}
document.getElementById("save")?.addEventListener("click", async () => {
  await saveConfig({
    apiBaseUrl: $("apiBaseUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    selfUserId: $("selfUserId").value.trim(),
    enabled: $("enabled").checked
  });
  const s = document.getElementById("status");
  if (s) {
    s.textContent = "Saved.";
    setTimeout(() => s.textContent = "", 1500);
  }
});
void bootstrap();
//# sourceMappingURL=options.js.map
