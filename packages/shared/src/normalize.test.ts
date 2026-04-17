import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizeHandle, normalizePhone, normalizeWaId } from './normalize.js';

describe('normalizePhone', () => {
  it('preserves a valid E.164 number', () => {
    expect(normalizePhone('+201234567890')).toBe('+201234567890');
  });
  it('adds leading + to bare digits', () => {
    expect(normalizePhone('201234567890')).toBe('+201234567890');
  });
  it('strips spaces and dashes', () => {
    expect(normalizePhone('+20 123 456-7890')).toBe('+201234567890');
  });
  it('strips parentheses', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
  });
  it('returns null for too-short numbers', () => {
    expect(normalizePhone('12345')).toBeNull();
  });
  it('returns null for empty/undefined/whitespace', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
  });
});

describe('normalizeWaId', () => {
  it('handles whatsapp bare-digit ids', () => {
    expect(normalizeWaId('201234567890')).toBe('+201234567890');
  });
});

describe('normalizeEmail', () => {
  it('lowercases + trims', () => {
    expect(normalizeEmail('  Islam.Yousry@GoldinKollar.com ')).toBe(
      'islam.yousry@goldinkollar.com',
    );
  });
  it('rejects strings without @', () => {
    expect(normalizeEmail('foo.com')).toBeNull();
  });
  it('rejects empty', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('normalizeHandle', () => {
  it('accepts numeric input', () => {
    expect(normalizeHandle(123456789)).toBe('123456789');
  });
  it('trims string input', () => {
    expect(normalizeHandle('  @islam  ')).toBe('@islam');
  });
  it('returns null for empty', () => {
    expect(normalizeHandle('')).toBeNull();
    expect(normalizeHandle(null)).toBeNull();
    expect(normalizeHandle(undefined)).toBeNull();
  });
});
