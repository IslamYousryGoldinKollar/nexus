import { describe, expect, it } from 'vitest';
import { gmailNotificationSchema, pubsubPushSchema } from './schema';

describe('gmail pub/sub envelope', () => {
  it('accepts a minimal valid push', () => {
    const res = pubsubPushSchema.safeParse({
      message: {
        data: Buffer.from(
          JSON.stringify({ emailAddress: 'x@goldinkollar.com', historyId: '1' }),
        ).toString('base64'),
        messageId: '123',
        publishTime: '2026-01-15T10:00:00Z',
      },
      subscription: 'projects/p/subscriptions/s',
    });
    expect(res.success).toBe(true);
  });

  it('rejects missing subscription', () => {
    const res = pubsubPushSchema.safeParse({
      message: { data: '', messageId: '1', publishTime: 'now' },
    });
    expect(res.success).toBe(false);
  });
});

describe('gmail notification inner payload', () => {
  it('accepts string historyId', () => {
    const res = gmailNotificationSchema.safeParse({
      emailAddress: 'x@goldinkollar.com',
      historyId: '12345',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.historyId).toBe('12345');
  });

  it('coerces numeric historyId to string', () => {
    const res = gmailNotificationSchema.safeParse({
      emailAddress: 'x@goldinkollar.com',
      historyId: 12345,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.historyId).toBe('12345');
  });
});
