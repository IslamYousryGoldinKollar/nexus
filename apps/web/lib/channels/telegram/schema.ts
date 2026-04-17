import { z } from 'zod';

/**
 * Zod schemas for the Telegram Bot API Update object.
 *
 * Reference: https://core.telegram.org/bots/api#update
 *
 * We validate the subset we care about for ingestion (messages from users
 * to the bot or groups the bot is in). Approval `callback_query` handling
 * lives in Phase 9 alongside the real fallback bot.
 */

const photoSize = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  width: z.number(),
  height: z.number(),
  file_size: z.number().optional(),
});

const voice = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  duration: z.number(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

const audio = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  duration: z.number().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
  title: z.string().optional(),
  performer: z.string().optional(),
});

const videoFile = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

const documentFile = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().optional(),
});

export const telegramUser = z.object({
  id: z.number(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

export const telegramChat = z.object({
  id: z.number(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

export const telegramMessage = z.object({
  message_id: z.number(),
  from: telegramUser.optional(),
  sender_chat: telegramChat.optional(),
  chat: telegramChat,
  date: z.number(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: voice.optional(),
  audio: audio.optional(),
  video: videoFile.optional(),
  document: documentFile.optional(),
  photo: z.array(photoSize).optional(),
  video_note: videoFile.optional(),
  sticker: z
    .object({
      file_id: z.string(),
      file_unique_id: z.string(),
      mime_type: z.string().optional(),
      emoji: z.string().optional(),
    })
    .optional(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
    })
    .optional(),
  contact: z
    .object({
      phone_number: z.string(),
      first_name: z.string(),
      last_name: z.string().optional(),
      user_id: z.number().optional(),
    })
    .optional(),
  reply_to_message: z
    .object({ message_id: z.number(), chat: telegramChat })
    .optional(),
});
export type TelegramMessage = z.infer<typeof telegramMessage>;

export const telegramUpdate = z
  .object({
    update_id: z.number(),
    message: telegramMessage.optional(),
    edited_message: telegramMessage.optional(),
    channel_post: telegramMessage.optional(),
    edited_channel_post: telegramMessage.optional(),
    callback_query: z
      .object({
        id: z.string(),
        from: telegramUser,
        data: z.string().optional(),
        message: telegramMessage.optional(),
      })
      .optional(),
  })
  .passthrough();
export type TelegramUpdate = z.infer<typeof telegramUpdate>;
