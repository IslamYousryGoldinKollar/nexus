import { loadConfig, saveConfig } from '../storage';

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function bootstrap() {
  const cfg = await loadConfig();
  $('apiBaseUrl').value = cfg.apiBaseUrl;
  $('apiKey').value = cfg.apiKey;
  $('selfUserId').value = cfg.selfUserId;
  $('enabled').checked = cfg.enabled;
}

document.getElementById('save')?.addEventListener('click', async () => {
  await saveConfig({
    apiBaseUrl: $('apiBaseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    selfUserId: $('selfUserId').value.trim(),
    enabled: $('enabled').checked,
  });
  const s = document.getElementById('status');
  if (s) {
    s.textContent = 'Saved.';
    setTimeout(() => (s.textContent = ''), 1500);
  }
});

void bootstrap();
