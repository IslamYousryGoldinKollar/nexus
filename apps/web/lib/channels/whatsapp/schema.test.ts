import { describe, expect, it } from 'vitest';
import { whatsappWebhookSchema } from './schema';

const textFixture = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '123',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '1234', phone_number_id: '5678' },
            contacts: [{ profile: { name: 'Ahmed' }, wa_id: '201234567890' }],
            messages: [
              {
                from: '201234567890',
                id: 'wamid.ABC-text',
                timestamp: '1747000000',
                type: 'text',
                text: { body: 'Hello world' },
              },
            ],
          },
        },
      ],
    },
  ],
};

const voiceFixture = {
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
                id: 'wamid.ABC-voice',
                timestamp: '1747000001',
                type: 'audio',
                audio: {
                  id: 'media_id_123',
                  mime_type: 'audio/ogg',
                  sha256: 'abc...',
                  voice: true,
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

const statusFixture = {
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
                id: 'wamid.ABC',
                status: 'delivered',
                timestamp: '1747000002',
                recipient_id: '201234567890',
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('whatsapp schema', () => {
  it('accepts a text message payload', () => {
    const res = whatsappWebhookSchema.safeParse(textFixture);
    expect(res.success).toBe(true);
  });

  it('accepts a voice message payload with media reference', () => {
    const res = whatsappWebhookSchema.safeParse(voiceFixture);
    expect(res.success).toBe(true);
  });

  it('accepts a status update payload', () => {
    const res = whatsappWebhookSchema.safeParse(statusFixture);
    expect(res.success).toBe(true);
  });

  it('accepts an unknown message type (forward-compat)', () => {
    const fixture = {
      ...textFixture,
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
                    from: '201',
                    id: 'wamid.future',
                    timestamp: '1',
                    type: 'some_future_type_meta_invented',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = whatsappWebhookSchema.safeParse(fixture);
    expect(res.success).toBe(true);
  });

  it('rejects payloads missing `object`', () => {
    const res = whatsappWebhookSchema.safeParse({ entry: [] });
    expect(res.success).toBe(false);
  });

  it('rejects non-whatsapp object types', () => {
    const res = whatsappWebhookSchema.safeParse({
      object: 'page', // e.g. Messenger
      entry: [],
    });
    expect(res.success).toBe(false);
  });

  it('rejects when metadata.phone_number_id is missing', () => {
    const res = whatsappWebhookSchema.safeParse({
      ...textFixture,
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {},
              },
            },
          ],
        },
      ],
    });
    expect(res.success).toBe(false);
  });
});
