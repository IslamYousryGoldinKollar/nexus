import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmac, bytesToHex } from '@nexus/shared';

/**
 * Integration tests for the WhatsApp ingestion webhook.
 *
 * Mocks:
 *   - @nexus/db         → fake upsertInteraction + insertAttachment
 *   - @nexus/inngest-fns → fake inngest.send (captures events)
 *   - ../../../../lib/r2 → fake uploadToR2 (no HTTP)
 *   - ../../../../lib/channels/whatsapp/media → fake downloadMedia
 */

const APP_SECRET = 'test-app-secret-123';
const VERIFY_TOKEN = 'verify-token-abc';

// --- Mocks ---------------------------------------------------------------

const upsertInteractionMock = vi.fn();
const insertAttachmentMock = vi.fn();
const inngestSendMock = vi.fn().mockResolvedValue(undefined);
const uploadToR2Mock = vi.fn();
const downloadMediaMock = vi.fn();

vi.mock('@nexus/db', () => ({
  upsertInteraction: (...args: unknown[]) => upsertInteractionMock(...args),
  insertAttachment: (...args: unknown[]) => insertAttachmentMock(...args),
  getDb: () => ({ __fake: true }),
}));

vi.mock('@nexus/inngest-fns', () => ({
  inngest: { send: (...args: unknown[]) => inngestSendMock(...args) },
}));

vi.mock('@/lib/r2', () => ({
  uploadToR2: (...args: unknown[]) => uploadToR2Mock(...args),
}));

vi.mock('@/lib/channels/whatsapp/media', () => ({
  downloadMedia: (...args: unknown[]) => downloadMediaMock(...args),
  WhatsappMediaError: class extends Error {
    status?: number;
    mediaId?: string;
  },
}));

// --- Env setup -----------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
  process.env.APP_URL = 'http://localhost:3000';
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  process.env.WHATSAPP_ACCESS_TOKEN = 'token';
});

afterEach(() => {
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  delete process.env.WHATSAPP_ACCESS_TOKEN;
});

// --- Helpers -------------------------------------------------------------

async function signedRequest(body: unknown) {
  const rawText = JSON.stringify(body);
  const sig = await hmac(APP_SECRET, rawText, 'SHA-256');
  const header = `sha256=${bytesToHex(sig)}`;
  return new Request('https://nexus.test/api/ingest/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': header,
    },
    body: rawText,
  });
}

const textPayload = () => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '123',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '5678' },
            messages: [
              {
                from: '201234567890',
                id: 'wamid.TEXT1',
                timestamp: '1747000000',
                type: 'text',
                text: { body: 'Hello' },
              },
            ],
          },
        },
      ],
    },
  ],
});

const audioPayload = () => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '123',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '5678' },
            messages: [
              {
                from: '201234567890',
                id: 'wamid.AUDIO1',
                timestamp: '1747000001',
                type: 'audio',
                audio: {
                  id: 'media_id_AUDIO1',
                  mime_type: 'audio/ogg',
                  voice: true,
                },
              },
            ],
          },
        },
      ],
    },
  ],
});

// --- Tests ---------------------------------------------------------------

describe('POST /api/ingest/whatsapp', () => {
  it('rejects missing signature with 200 + error body (no retry storm)', async () => {
    const { POST } = await import('./route');
    const req = new Request('https://nexus.test/api/ingest/whatsapp', {
      method: 'POST',
      body: JSON.stringify(textPayload()),
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('signature_verification_failed');
    expect(upsertInteractionMock).not.toHaveBeenCalled();
  });

  it('rejects tampered body with signature failure', async () => {
    const { POST } = await import('./route');
    const rawText = JSON.stringify(textPayload());
    const sig = await hmac(APP_SECRET, rawText, 'SHA-256');
    const req = new Request('https://nexus.test/api/ingest/whatsapp', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': `sha256=${bytesToHex(sig)}`,
      },
      // tamper the body after signing
      body: rawText.replace('Hello', 'Goodbye'),
    });
    const res = await POST(req as unknown as NextRequest);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('signature_verification_failed');
  });

  it('persists a text message + emits interaction.ingested', async () => {
    upsertInteractionMock.mockResolvedValue({
      interaction: { id: 'int-1', channel: 'whatsapp' },
      inserted: true,
    });
    const { POST } = await import('./route');
    const req = await signedRequest(textPayload());
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ingested: number };
    expect(json.ingested).toBe(1);

    expect(upsertInteractionMock).toHaveBeenCalledOnce();
    const [, row] = upsertInteractionMock.mock.calls[0]!;
    expect(row).toMatchObject({
      channel: 'whatsapp',
      direction: 'inbound',
      contentType: 'text',
      text: 'Hello',
      sourceMessageId: 'wamid.TEXT1',
    });

    expect(inngestSendMock).toHaveBeenCalledOnce();
    expect(inngestSendMock.mock.calls[0]![0]).toMatchObject({
      name: 'nexus/interaction.ingested',
      data: {
        interactionId: 'int-1',
        channel: 'whatsapp',
        sourceMessageId: 'wamid.TEXT1',
      },
    });

    // text messages carry no media — these must NOT be called
    expect(downloadMediaMock).not.toHaveBeenCalled();
    expect(insertAttachmentMock).not.toHaveBeenCalled();
  });

  it('downloads + uploads media for audio messages', async () => {
    upsertInteractionMock.mockResolvedValue({
      interaction: { id: 'int-audio', channel: 'whatsapp' },
      inserted: true,
    });
    downloadMediaMock.mockResolvedValue({
      bytes: new Uint8Array([0, 1, 2, 3, 4]),
      mimeType: 'audio/ogg',
      sizeBytes: 5,
      remoteSha256: 'abc',
    });
    uploadToR2Mock.mockResolvedValue({
      key: 'whatsapp/2026/05/01/abc.ogg',
      checksumHex: 'abc',
      sizeBytes: 5,
      mimeType: 'audio/ogg',
      alreadyExisted: false,
    });
    insertAttachmentMock.mockResolvedValue({ id: 'att-1' });

    const { POST } = await import('./route');
    const req = await signedRequest(audioPayload());
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);

    expect(downloadMediaMock).toHaveBeenCalledWith('media_id_AUDIO1');
    expect(uploadToR2Mock).toHaveBeenCalledOnce();
    expect(uploadToR2Mock.mock.calls[0]![0]).toMatchObject({
      channel: 'whatsapp',
      mimeType: 'audio/ogg',
    });
    expect(insertAttachmentMock).toHaveBeenCalledOnce();
    const [, row] = insertAttachmentMock.mock.calls[0]!;
    expect(row).toMatchObject({
      interactionId: 'int-audio',
      r2Key: 'whatsapp/2026/05/01/abc.ogg',
      checksum: 'abc',
    });
  });

  it('skips media download when the interaction already existed (idempotency)', async () => {
    upsertInteractionMock.mockResolvedValue({
      interaction: { id: 'int-dupe', channel: 'whatsapp' },
      inserted: false,
    });

    const { POST } = await import('./route');
    const req = await signedRequest(audioPayload());
    await POST(req as unknown as NextRequest);

    expect(downloadMediaMock).not.toHaveBeenCalled();
    expect(uploadToR2Mock).not.toHaveBeenCalled();
    expect(insertAttachmentMock).not.toHaveBeenCalled();
    // No event fires for dupes either.
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('returns 200 + ignored on schema mismatch (no retry storm)', async () => {
    const { POST } = await import('./route');
    const req = await signedRequest({ not: 'whatsapp' });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored: string };
    expect(json.ignored).toBe('schema_mismatch');
    expect(upsertInteractionMock).not.toHaveBeenCalled();
  });

  it('skips status updates (delivery receipts)', async () => {
    const { POST } = await import('./route');
    const statusOnly = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '123',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '5678' },
                statuses: [
                  {
                    id: 'wamid.X',
                    status: 'delivered',
                    timestamp: '1747000002',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const req = await signedRequest(statusOnly);
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(upsertInteractionMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/ingest/whatsapp (verification handshake)', () => {
  it('returns the hub.challenge on a correct subscribe request', async () => {
    const { GET } = await import('./route');
    const req = new Request(
      `https://nexus.test/api/ingest/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`,
    ) as unknown as NextRequest;
    // NextRequest requires `nextUrl`; fake it minimally.
    (req as unknown as { nextUrl: URL }).nextUrl = new URL(req.url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('42');
  });

  it('returns 403 on a wrong verify token', async () => {
    const { GET } = await import('./route');
    const req = new Request(
      `https://nexus.test/api/ingest/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=42`,
    ) as unknown as NextRequest;
    (req as unknown as { nextUrl: URL }).nextUrl = new URL(req.url);
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});
