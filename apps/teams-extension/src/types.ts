/**
 * Extension config persisted in chrome.storage.sync.
 *
 * `apiBaseUrl` + `apiKey` point at the Nexus deployment. The server's
 * /api/ingest/meeting endpoint accepts both HMAC (for backend clients)
 * and Bearer (for this in-browser client) auth — we use the Bearer
 * path because the extension can't safely hold an HMAC secret in its
 * bundle.
 */
export interface ExtensionConfig {
  apiBaseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  apiBaseUrl: 'https://nexus-beta-coral.vercel.app',
  apiKey: '',
  enabled: true,
};

/**
 * Messages exchanged between popup ↔ background SW ↔ offscreen page.
 * Discriminated by `type`. Returned values flow back via the same
 * sendResponse channel; nothing is fire-and-forget.
 */
export type ExtMessage =
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_STATUS' }
  | {
      type: 'STATUS';
      recording: boolean;
      durationMs: number;
      uploading: boolean;
      lastError?: string;
      lastInteractionId?: string;
    }
  // SW → offscreen
  | { type: 'OFFSCREEN_START'; streamId: string; startedAt: string }
  | { type: 'OFFSCREEN_STOP' }
  // offscreen → SW
  | {
      type: 'OFFSCREEN_RESULT';
      ok: true;
      mimeType: string;
      bytesBase64: string;
      startedAt: string;
      endedAt: string;
    }
  | { type: 'OFFSCREEN_RESULT'; ok: false; error: string };
