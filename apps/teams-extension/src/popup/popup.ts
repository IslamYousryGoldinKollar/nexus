import { loadConfig } from '../storage';
import type { ExtMessage } from '../types';

/**
 * Popup UI for the meeting recorder.
 *
 * Polls the SW for STATUS every 500 ms while the popup is open so the
 * timer keeps ticking and uploads/errors surface immediately. The
 * record/stop button dispatches START_RECORDING / STOP_RECORDING with
 * the active tab's id.
 */

const els = {
  state: document.getElementById('state') as HTMLSpanElement,
  timer: document.getElementById('timer') as HTMLSpanElement,
  action: document.getElementById('action') as HTMLButtonElement,
  msg: document.getElementById('msg') as HTMLDivElement,
};

document.getElementById('open-options')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
document.getElementById('open-tasks')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const cfg = await loadConfig();
  if (cfg.apiBaseUrl) {
    void chrome.tabs.create({ url: `${cfg.apiBaseUrl.replace(/\/$/, '')}/approvals` });
  }
});

els.action.addEventListener('click', () => {
  void onActionClick();
});

async function onActionClick(): Promise<void> {
  els.action.disabled = true;
  try {
    const status = await getStatus();
    if (status.recording) {
      await sendMessage({ type: 'STOP_RECORDING' });
      els.msg.innerHTML = '<div class="ok">Stopping… uploading audio.</div>';
    } else {
      const cfg = await loadConfig();
      if (!cfg.apiBaseUrl || !cfg.apiKey) {
        els.msg.innerHTML =
          '<div class="err">Configure Base URL + API key in Options first.</div>';
        return;
      }
      const tab = await activeTab();
      if (!tab?.id) {
        els.msg.innerHTML = '<div class="err">No active tab found.</div>';
        return;
      }
      const result = await sendMessage<{ ok: boolean; error?: string }>({
        type: 'START_RECORDING',
        tabId: tab.id,
      });
      if (!result?.ok) {
        els.msg.innerHTML = `<div class="err">${escape(result?.error ?? 'failed')}</div>`;
        return;
      }
      els.msg.innerHTML = '';
    }
  } finally {
    els.action.disabled = false;
    await render();
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function sendMessage<T>(msg: ExtMessage): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp: T) => resolve(resp));
  });
}

async function getStatus(): Promise<Extract<ExtMessage, { type: 'STATUS' }>> {
  const fallback: Extract<ExtMessage, { type: 'STATUS' }> = {
    type: 'STATUS',
    recording: false,
    durationMs: 0,
    uploading: false,
  };
  const r = await sendMessage<Extract<ExtMessage, { type: 'STATUS' }> | undefined>({
    type: 'GET_STATUS',
  });
  return r ?? fallback;
}

async function render(): Promise<void> {
  const status = await getStatus();
  if (status.recording) {
    els.state.textContent = '● Recording';
    els.state.className = 'pill live';
    els.timer.textContent = formatDuration(status.durationMs);
    els.action.textContent = 'Stop & upload';
    els.action.className = 'stop';
    return;
  }
  if (status.uploading) {
    els.state.textContent = '↑ Uploading';
    els.state.className = 'pill uploading';
    els.timer.textContent = '';
    els.action.textContent = 'Start recording';
    els.action.className = 'start';
    els.action.disabled = true;
    return;
  }
  els.action.disabled = false;
  els.action.textContent = 'Start recording';
  els.action.className = 'start';
  els.timer.textContent = '';

  if (status.lastError) {
    els.state.textContent = '⚠ Error';
    els.state.className = 'pill err';
    els.msg.innerHTML = `<div class="err">${escape(status.lastError)}</div>`;
    return;
  }
  if (status.lastInteractionId) {
    els.state.textContent = '✓ Uploaded';
    els.state.className = 'pill ok';
    els.msg.innerHTML = `<div class="ok">Sent — interaction <code>${escape(
      status.lastInteractionId.slice(0, 8),
    )}</code>. Transcription + reasoning kick in within ~2 min.</div>`;
    return;
  }
  els.state.textContent = 'Idle';
  els.state.className = 'pill idle';
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

void render();
setInterval(() => void render(), 500);
