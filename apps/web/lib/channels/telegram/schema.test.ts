import { describe, expect, it } from 'vitest';
import { telegramUpdate } from './schema';

describe('telegram update schema', () => {
  it('accepts a text message in a private chat', () => {
    const res = telegramUpdate.safeParse({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 999, is_bot: false, first_name: 'Client' },
        chat: { id: 999, type: 'private', first_name: 'Client' },
        date: 1747000000,
        text: 'Hi',
      },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a voice message', () => {
    const res = telegramUpdate.safeParse({
      update_id: 2,
      message: {
        message_id: 11,
        from: { id: 999, is_bot: false, first_name: 'C' },
        chat: { id: 999, type: 'private', first_name: 'C' },
        date: 1747000001,
        voice: {
          file_id: 'AwACAgIAAxkBAAIB',
          file_unique_id: 'ABC',
          duration: 5,
          mime_type: 'audio/ogg',
          file_size: 12345,
        },
      },
    });
    expect(res.success).toBe(true);
  });

  it('accepts a callback_query (Phase 9 approval button)', () => {
    const res = telegramUpdate.safeParse({
      update_id: 3,
      callback_query: {
        id: '123',
        from: { id: 999, is_bot: false, first_name: 'Islam' },
        data: 'approve:task123',
      },
    });
    expect(res.success).toBe(true);
  });

  it('accepts edited_message and channel_post', () => {
    const edited = telegramUpdate.safeParse({
      update_id: 4,
      edited_message: {
        message_id: 12,
        chat: { id: 999, type: 'private' },
        date: 1747000002,
        text: 'fixed',
      },
    });
    expect(edited.success).toBe(true);

    const channel = telegramUpdate.safeParse({
      update_id: 5,
      channel_post: {
        message_id: 13,
        chat: { id: -100999, type: 'channel', title: 'Announcements' },
        date: 1747000003,
        text: 'hello channel',
      },
    });
    expect(channel.success).toBe(true);
  });

  it('rejects a payload with no update_id', () => {
    const res = telegramUpdate.safeParse({ message: { message_id: 1 } });
    expect(res.success).toBe(false);
  });

  it('passes through unknown fields (forward-compat)', () => {
    const res = telegramUpdate.safeParse({
      update_id: 6,
      some_future_field: { anything: true },
      message: {
        message_id: 14,
        chat: { id: 1, type: 'private' },
        date: 1,
        text: 'x',
      },
    });
    expect(res.success).toBe(true);
  });
});
