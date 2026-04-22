import { z } from 'zod';

/**
 * Wire format between @nexus/wa-bridge (Baileys worker) and the Nexus
 * Vercel endpoint. Kept intentionally small and stable — the bridge is
 * deployed out-of-band so schema drift is costly.
 */

export const baileysMessageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  fromMe: z.boolean(),
  timestamp: z.number().int().nonnegative(),
  type: z.enum([
    'text',
    'image',
    'audio',
    'video',
    'document',
    'sticker',
    'location',
    'contact',
    'unknown',
  ]),
  text: z.string().nullable(),
  media: z
    .object({
      storageKey: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.number().int().nonnegative(),
      checksumHex: z.string().regex(/^[a-f0-9]{64}$/),
      filename: z.string().optional(),
    })
    .optional(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().optional(),
      address: z.string().optional(),
    })
    .optional(),
  raw: z.unknown().optional(),
});

export const baileysEnvelopeSchema = z.object({
  source: z.literal('baileys'),
  device: z.string(),
  receivedAt: z.string(), // ISO
  messages: z.array(baileysMessageSchema).max(200),
});

export type BaileysMessage = z.infer<typeof baileysMessageSchema>;
export type BaileysEnvelope = z.infer<typeof baileysEnvelopeSchema>;
