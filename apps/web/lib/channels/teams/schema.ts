import { z } from 'zod';

/**
 * Teams ingest payload — pushed by the Chrome extension after scraping
 * teams.microsoft.com.
 *
 * The extension is responsible for de-duplication on its side; we
 * tolerate retries via UNIQUE(channel, source_message_id).
 */
export const teamsIngestSchema = z.object({
  // Stable id from the Teams DOM (data-mid attribute on the message div).
  messageId: z.string().min(1),
  // Sender (user_aad_object_id_or_username — we store as opaque).
  fromUserId: z.string().min(1),
  fromName: z.string().optional(),
  // Conversation/thread id.
  conversationId: z.string().min(1),
  // Direction relative to the watching admin.
  direction: z.enum(['inbound', 'outbound']),
  text: z.string().optional(),
  // ISO 8601 timestamp.
  occurredAt: z.string().datetime(),
  // Optional attachment URL (the scraper resolves the blob URL).
  attachmentUrl: z.string().url().optional(),
  attachmentMime: z.string().optional(),
});

export type TeamsIngestPayload = z.infer<typeof teamsIngestSchema>;
