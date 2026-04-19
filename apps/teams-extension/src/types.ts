/**
 * Wire-format payload pushed by the content script to the background
 * worker, and from background to /api/ingest/teams.
 *
 * Mirrors `apps/web/lib/channels/teams/schema.ts:teamsIngestSchema`.
 */
export interface TeamsIngestPayload {
  messageId: string;
  fromUserId: string;
  fromName?: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  text?: string;
  occurredAt: string; // ISO 8601
  attachmentUrl?: string;
  attachmentMime?: string;
}

export interface ExtensionConfig {
  apiBaseUrl: string;
  apiKey: string;
  selfUserId: string; // user.id of the admin running the extension; used
                       // to decide direction
  enabled: boolean;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  apiBaseUrl: 'https://nexus.goldinkollar.com',
  apiKey: '',
  selfUserId: '',
  enabled: false,
};
