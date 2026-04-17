import { describe, expect, it } from 'vitest';
import { extractIdentifier } from './extract-identifier.js';

describe('extractIdentifier / whatsapp', () => {
  it('pulls E.164 from wa_id in the raw message', () => {
    const result = extractIdentifier('whatsapp', {
      from: '201234567890',
      id: 'wamid.x',
      type: 'text',
    });
    expect(result).toEqual({
      kind: 'whatsapp_wa_id',
      value: '+201234567890',
      displayHint: '201234567890',
    });
  });

  it('returns null when from field is missing', () => {
    const result = extractIdentifier('whatsapp', {
      id: 'wamid.x',
      type: 'text',
    });
    expect(result).toBeNull();
  });
});

describe('extractIdentifier / telegram', () => {
  it('uses from.id for DMs', () => {
    const result = extractIdentifier('telegram', {
      from: { id: 999, username: 'client', first_name: 'C' },
      chat: { id: 999, type: 'private' },
      text: 'hi',
    });
    expect(result).toEqual({
      kind: 'telegram_user_id',
      value: '999',
      displayHint: '@client',
    });
  });

  it('falls back to chat.id for channels', () => {
    const result = extractIdentifier('telegram', {
      chat: { id: -100999, type: 'channel', title: 'Announcements' },
      text: 'hi',
    });
    expect(result).toEqual({
      kind: 'telegram_user_id',
      value: '-100999',
      displayHint: 'Announcements',
    });
  });
});

describe('extractIdentifier / phone', () => {
  it('normalizes counterparty field', () => {
    const result = extractIdentifier('phone', {
      counterparty: '+1 555-123-4567',
      direction: 'inbound',
    });
    expect(result).toEqual({
      kind: 'phone',
      value: '+15551234567',
      displayHint: '+1 555-123-4567',
    });
  });
});

describe('extractIdentifier / gmail', () => {
  it('normalizes lowercase email from from field when present', () => {
    const result = extractIdentifier('gmail', { from: 'A@B.com' });
    expect(result).toEqual({
      kind: 'email',
      value: 'a@b.com',
      displayHint: 'A@B.com',
    });
  });

  it('returns null when the Pub/Sub envelope carries no sender', () => {
    const result = extractIdentifier('gmail', {
      message: { data: 'eyJ...', messageId: '1' },
      subscription: 'projects/p/subscriptions/s',
    });
    expect(result).toBeNull();
  });
});

describe('extractIdentifier / teams', () => {
  it('uses from.id', () => {
    const result = extractIdentifier('teams', {
      from: { id: 'user-abc', name: 'Ahmed' },
    });
    expect(result).toEqual({
      kind: 'teams_user_id',
      value: 'user-abc',
    });
  });
});

describe('extractIdentifier / defensive', () => {
  it('returns null for null payload', () => {
    expect(extractIdentifier('whatsapp', null)).toBeNull();
  });
  it('returns null for string payload', () => {
    expect(extractIdentifier('whatsapp', 'not an object')).toBeNull();
  });
});
