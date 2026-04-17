import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'telegram-webhook-secret';

// --- Mocks ---------------------------------------------------------------

const upsertInteractionMock = vi.fn();
const insertAttachmentMock = vi.fn();
const inngestSendMock = vi.fn().mockResolvedValue(undefined);
const uploadToR2Mock = vi.fn();
const downloadFileMock = vi.fn();

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

vi.mock('@/lib/channels/telegram/media', () => ({
  downloadFile: (...args: unknown[]) => downloadFileMock(...args),
  TelegramMediaError: class extends Error {
    status?: number;
    fileId?: string;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgres://u:p@h:5432/db';
  process.env.APP_URL = 'http://localhost:3000';
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
});

afterEach(() => {
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

function makeRequest(payload: unknown, secretOverride?: string) {
  return new Request('https://nexus.test/api/ingest/telegram', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secretOverride ?? SECRET,
    },
    body: JSON.stringify(payload),
  });
}

const textUpdate = () => ({
  update_id: 1,
  message: {
    message_id: 101,
    from: { id: 2001, is_bot: false, first_name: 'Client' },
    chat: { id: 2001, type: 'private', first_name: 'Client' },
    date: 1747000000,
    text: 'Hello Nexus',
  },
});

const voiceUpdate = () => ({
  update_id: 2,
  message: {
    message_id: 102,
    from: { id: 2001, is_bot: false, first_name: 'Client' },
    chat: { id: 2001, type: 'private', first_name: 'Client' },
    date: 1747000001,
    voice: {
      file_id: 'voicefile',
      file_unique_id: 'vu',
      duration: 10,
      mime_type: 'audio/ogg',
      file_size: 9999,
    },
  },
});

describe('POST /api/ingest/telegram', () => {
  it('rejects a wrong secret-token header', async () => {
    const { POST } = await import('./route');
    const req = makeRequest(textUpdate(), 'wrong-secret');
    const res = await POST(req as unknown as NextRequest);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('signature_verification_failed');
    expect(upsertInteractionMock).not.toHaveBeenCalled();
  });

  it('rejects when no header is present', async () => {
    const { POST } = await import('./route');
    const req = new Request('https://nexus.test/api/ingest/telegram', {
      method: 'POST',
      body: JSON.stringify(textUpdate()),
    });
    const res = await POST(req as unknown as NextRequest);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('signature_verification_failed');
  });

  it('persists a text message from a private chat', async () => {
    upsertInteractionMock.mockResolvedValue({
      interaction: { id: 'int-tg-text' },
      inserted: true,
    });
    const { POST } = await import('./route');
    const res = await POST(
      makeRequest(textUpdate()) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);

    expect(upsertInteractionMock).toHaveBeenCalledOnce();
    const [, row] = upsertInteractionMock.mock.calls[0]!;
    expect(row).toMatchObject({
      channel: 'telegram',
      direction: 'inbound',
      contentType: 'text',
      text: 'Hello Nexus',
      sourceMessageId: '2001:101',
    });

    expect(inngestSendMock).toHaveBeenCalledOnce();
    expect(inngestSendMock.mock.calls[0]![0]).toMatchObject({
      name: 'nexus/interaction.ingested',
      data: { channel: 'telegram', sourceMessageId: '2001:101' },
    });
  });

  it('downloads media for voice messages and attaches them', async () => {
    upsertInteractionMock.mockResolvedValue({
      interaction: { id: 'int-tg-voice' },
      inserted: true,
    });
    downloadFileMock.mockResolvedValue({
      bytes: new Uint8Array([9, 9, 9]),
      sizeBytes: 3,
      mimeType: 'audio/ogg',
    });
    uploadToR2Mock.mockResolvedValue({
      key: 'telegram/2026/05/01/hash.ogg',
      checksumHex: 'hash',
      sizeBytes: 3,
      mimeType: 'audio/ogg',
      alreadyExisted: false,
    });
    insertAttachmentMock.mockResolvedValue({ id: 'att-tg' });

    const { POST } = await import('./route');
    await POST(
      makeRequest(voiceUpdate()) as unknown as NextRequest,
    );

    expect(downloadFileMock).toHaveBeenCalledWith('voicefile', 'audio/ogg');
    expect(uploadToR2Mock).toHaveBeenCalledOnce();
    expect(insertAttachmentMock).toHaveBeenCalledOnce();
  });

  it('skips callback_query updates (reserved for Phase 9)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeRequest({
        update_id: 5,
        callback_query: {
          id: 'cb-1',
          from: { id: 1, is_bot: false, first_name: 'Islam' },
          data: 'approve:x',
        },
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(upsertInteractionMock).not.toHaveBeenCalled();
  });

  it('skips edited messages (Phase 1 idempotency choice)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeRequest({
        update_id: 6,
        edited_message: {
          message_id: 50,
          chat: { id: 1, type: 'private' },
          date: 1747000000,
          text: 'fixed',
        },
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(upsertInteractionMock).not.toHaveBeenCalled();
  });

  it('returns 200 ignored on malformed payloads', async () => {
    const { POST } = await import('./route');
    const req = makeRequest({ bogus: true });
    const res = await POST(req as unknown as NextRequest);
    const json = (await res.json()) as { ignored?: string };
    expect(res.status).toBe(200);
    expect(json.ignored).toBe('schema_mismatch');
  });
});
