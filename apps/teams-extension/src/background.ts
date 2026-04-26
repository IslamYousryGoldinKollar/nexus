import { loadConfig } from './storage';
import type { TeamsIngestPayload } from './types';

/**
 * MV3 service worker.
 *
 * Receives messages from the content script:
 *   { type: 'INGEST', payload: TeamsIngestPayload }
 *
 * Forwards them to /api/ingest/teams with the user-configured bearer.
 * Failures are logged and silently dropped (we don't want to retry
 * endlessly on a permission error and burn user CPU).
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'INGEST') {
    sendResponse({ ok: false, error: 'unknown_msg' });
    return false;
  }
  // Async response.
  void handleIngest(msg.payload as TeamsIngestPayload).then(sendResponse).catch((e) => {
    sendResponse({ ok: false, error: (e as Error).message });
  });
  return true; // keep channel open
});

async function handleIngest(payload: TeamsIngestPayload): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { ok: true };
  if (!cfg.apiBaseUrl || !cfg.apiKey) return { ok: false, error: 'not_configured' };

  const res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, '')}/api/ingest/teams`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    return { ok: false, error: `http_${res.status}` };
  }
  return { ok: true };
}

// Optional: keep the SW warm by pinging on a cron-style alarm. Guarded
// because the `alarms` permission is technically optional — without it
// `chrome.alarms` is undefined and accessing `.create` would crash the
// service worker (Chrome reports this as "Service worker registration
// failed. Status code: 15").
if (chrome.alarms) {
  chrome.alarms.create('keepalive', { periodInMinutes: 4 });
  chrome.alarms.onAlarm.addListener(() => {
    // No-op; the alarm fire keeps the SW from being torn down between scrapes.
  });
}
