import { z } from 'zod';

/**
 * Google Pub/Sub push delivery envelope.
 *
 * The `data` field is a base64-encoded JSON payload. For Gmail watch
 * notifications, its decoded shape is:
 *   { emailAddress: "user@example.com", historyId: "12345" }
 *
 * Reference: https://cloud.google.com/pubsub/docs/push#receiving_messages
 */

export const pubsubPushSchema = z.object({
  message: z.object({
    data: z.string(), // base64-encoded
    messageId: z.string(),
    publishTime: z.string(),
    attributes: z.record(z.string()).optional(),
    orderingKey: z.string().optional(),
  }),
  subscription: z.string(),
});
export type PubsubPush = z.infer<typeof pubsubPushSchema>;

export const gmailNotificationSchema = z.object({
  emailAddress: z.string(),
  historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
});
export type GmailNotification = z.infer<typeof gmailNotificationSchema>;
