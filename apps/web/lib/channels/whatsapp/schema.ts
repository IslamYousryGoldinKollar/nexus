import { z } from 'zod';

/**
 * Zod schemas for WhatsApp Cloud API webhook payloads.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 *
 * We are tolerant by design — Meta adds new message types and fields
 * regularly, and we don't want a schema mismatch to 500 the webhook.
 * Unknown types fall through to `unknownMessage` and are ignored but
 * logged for visibility.
 */

const mediaRef = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
  voice: z.boolean().optional(),
});

const textMessage = z.object({
  type: z.literal('text'),
  text: z.object({ body: z.string() }),
});

const imageMessage = z.object({
  type: z.literal('image'),
  image: mediaRef,
});

const audioMessage = z.object({
  type: z.literal('audio'),
  audio: mediaRef,
});

const videoMessage = z.object({
  type: z.literal('video'),
  video: mediaRef,
});

const documentMessage = z.object({
  type: z.literal('document'),
  document: mediaRef,
});

const stickerMessage = z.object({
  type: z.literal('sticker'),
  sticker: mediaRef,
});

const locationMessage = z.object({
  type: z.literal('location'),
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
    address: z.string().optional(),
  }),
});

const contactsMessage = z.object({
  type: z.literal('contacts'),
  contacts: z.array(z.record(z.unknown())).min(1),
});

const interactiveMessage = z.object({
  type: z.literal('interactive'),
  interactive: z.record(z.unknown()),
});

const buttonMessage = z.object({
  type: z.literal('button'),
  button: z.object({
    payload: z.string().optional(),
    text: z.string().optional(),
  }),
});

const reactionMessage = z.object({
  type: z.literal('reaction'),
  reaction: z.object({
    message_id: z.string(),
    emoji: z.string(),
  }),
});

const unknownMessage = z.object({
  type: z.string(),
});

const messageBase = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(), // Unix seconds as string
  context: z
    .object({
      from: z.string().optional(),
      id: z.string().optional(),
    })
    .optional(),
});

export const whatsappMessageSchema = z.intersection(
  messageBase,
  z.union([
    textMessage,
    imageMessage,
    audioMessage,
    videoMessage,
    documentMessage,
    stickerMessage,
    locationMessage,
    contactsMessage,
    interactiveMessage,
    buttonMessage,
    reactionMessage,
    unknownMessage,
  ]),
);
export type WhatsappMessage = z.infer<typeof whatsappMessageSchema>;

const contactProfile = z.object({
  profile: z.object({ name: z.string().optional() }).optional(),
  wa_id: z.string(),
});

const statusUpdate = z.object({
  id: z.string(),
  status: z.string(), // 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: z.string(),
  recipient_id: z.string().optional(),
});

export const whatsappChangeSchema = z.object({
  value: z.object({
    messaging_product: z.literal('whatsapp'),
    metadata: z
      .object({
        display_phone_number: z.string().optional(),
        phone_number_id: z.string(),
      })
      .passthrough(),
    contacts: z.array(contactProfile).optional(),
    messages: z.array(whatsappMessageSchema).optional(),
    statuses: z.array(statusUpdate).optional(),
    errors: z.array(z.record(z.unknown())).optional(),
  }),
  field: z.string(),
});
export type WhatsappChange = z.infer<typeof whatsappChangeSchema>;

export const whatsappWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(whatsappChangeSchema),
    }),
  ),
});
export type WhatsappWebhookPayload = z.infer<typeof whatsappWebhookSchema>;
