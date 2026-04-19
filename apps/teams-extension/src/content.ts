import { loadConfig } from './storage';
import type { TeamsIngestPayload } from './types';

/**
 * Content script — runs inside teams.microsoft.com. Watches for new
 * message DOM nodes, extracts the canonical fields, and posts them to
 * the background SW which forwards to our API.
 *
 * Caveats:
 *   - Teams ships React Fiber + heavy virtualization. The DOM
 *     selectors below match the mid-2025 chat UI; expect to update
 *     them as Teams iterates.
 *   - We only scrape DMs (`/v2/conversations/{convId}/messages`). Channel
 *     posts are intentionally out of scope for v1.
 *   - Attachments: we capture the blob URL; the server fetches the
 *     bytes itself (Teams blob URLs require auth → see Phase 10+).
 */

const SEEN = new Set<string>();
const STARTED_AT = Date.now();

async function maybeIngest(node: Element): Promise<void> {
  const messageId = node.getAttribute('data-mid') ?? node.getAttribute('data-message-id');
  if (!messageId) return;
  if (SEEN.has(messageId)) return;

  // Skip everything that was already on screen when we loaded; we only
  // ingest messages received after the extension started.
  const tsRaw = node.getAttribute('data-ts');
  const ts = tsRaw ? Number(tsRaw) * (tsRaw.length > 11 ? 1 : 1000) : Date.now();
  if (ts < STARTED_AT) {
    SEEN.add(messageId);
    return;
  }

  const cfg = await loadConfig();
  if (!cfg.enabled) return;

  const fromEl = node.querySelector('[data-tid="messageBodySender"]');
  const fromName = fromEl?.textContent?.trim();
  const fromUserId = fromEl?.getAttribute('data-userid') ?? fromName ?? 'unknown';
  const direction: TeamsIngestPayload['direction'] =
    cfg.selfUserId && fromUserId === cfg.selfUserId ? 'outbound' : 'inbound';

  const textEl = node.querySelector('[data-tid="messageBodyContent"]');
  const text = textEl?.textContent?.trim() ?? undefined;

  const attEl = node.querySelector('a[data-tid="file-link"]');
  const attachmentUrl = attEl?.getAttribute('href') ?? undefined;

  const conversationId =
    document.querySelector('[data-tid="chat-pane-list"]')?.getAttribute('data-conversation-id') ??
    location.pathname.split('/').pop() ??
    'unknown';

  const payload: TeamsIngestPayload = {
    messageId,
    fromUserId,
    fromName,
    conversationId,
    direction,
    text,
    occurredAt: new Date(ts).toISOString(),
    attachmentUrl,
    attachmentMime: attachmentUrl ? guessMime(attachmentUrl) : undefined,
  };

  SEEN.add(messageId);
  chrome.runtime.sendMessage({ type: 'INGEST', payload }).catch(() => {});
}

function guessMime(url: string): string | undefined {
  const u = url.toLowerCase();
  if (u.includes('.mp4')) return 'video/mp4';
  if (u.includes('.m4a')) return 'audio/mp4';
  if (u.includes('.mp3')) return 'audio/mpeg';
  if (u.includes('.wav')) return 'audio/wav';
  if (u.includes('.png')) return 'image/png';
  if (u.includes('.jpg') || u.includes('.jpeg')) return 'image/jpeg';
  if (u.includes('.pdf')) return 'application/pdf';
  return undefined;
}

const obs = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of Array.from(m.addedNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.matches('[data-mid], [data-message-id]')) void maybeIngest(node);
      node.querySelectorAll?.('[data-mid], [data-message-id]').forEach((n) => void maybeIngest(n));
    }
  }
});

function start() {
  obs.observe(document.body, { childList: true, subtree: true });
  // Initial sweep — most messages already in the DOM are pre-extension.
  document.querySelectorAll('[data-mid], [data-message-id]').forEach((n) => void maybeIngest(n));
}

if (document.readyState === 'complete') start();
else window.addEventListener('load', start);
