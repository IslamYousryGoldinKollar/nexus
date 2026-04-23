/**
 * Gmail API client for fetching email content.
 */

interface GmailMessage {
  id: string;
  threadId: string;
  payload: {
    headers: { name: string; value: string }[];
    body?: { data: string };
    parts?: GmailMessagePart[];
  };
  internalDate: string;
  snippet: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailHistory {
  historyId: string;
  history: Array<{
    id: string;
    messagesAdded?: Array<{ message: GmailMessage }>;
    messagesDeleted?: Array<{ message: GmailMessage }>;
  }>;
}

export interface GmailEmail {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  timestamp: number;
  snippet: string;
}

/**
 * Get a fresh access token from refresh token.
 */
export async function getGmailAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get access token: ${response.statusText}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Fetch history since a given history ID.
 */
export async function getGmailHistory(
  accessToken: string,
  startHistoryId?: string,
): Promise<GmailHistory | null> {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history');
  if (startHistoryId) {
    url.searchParams.set('startHistoryId', startHistoryId);
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null; // No history
    }
    throw new Error(`Failed to fetch history: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch a full Gmail message by ID.
 */
export async function getGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailEmail | null> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch message: ${response.statusText}`);
  }

  const message: GmailMessage = await response.json();
  return parseGmailMessage(message);
}

/**
 * Parse a Gmail message into a simplified format.
 */
function parseGmailMessage(message: GmailMessage): GmailEmail | null {
  const headers = message.payload.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name)?.value || '';

  const from = getHeader('From');
  const to = getHeader('To')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const subject = getHeader('Subject');

  // Extract body from parts
  const body = extractBody(message.payload);

  return {
    id: message.id,
    threadId: message.threadId,
    from,
    to,
    subject,
    body,
    timestamp: parseInt(message.internalDate, 10),
    snippet: message.snippet,
  };
}

/**
 * Extract text body from Gmail message parts.
 */
function extractBody(part: GmailMessagePart): string {
  if (part.body?.data) {
    // Base64 decode
    return Buffer.from(part.body.data, 'base64').toString('utf-8');
  }

  if (part.parts) {
    // Recursively extract from parts
    for (const p of part.parts) {
      if (p.mimeType === 'text/plain') {
        const body = extractBody(p);
        if (body) return body;
      }
    }
  }

  return '';
}
