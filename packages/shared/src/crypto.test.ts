import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  hmac,
  safeStringEqual,
  timingSafeEqual,
  verifyHmac,
} from './crypto.js';

describe('crypto / hex conversion', () => {
  it('round-trips bytes → hex → bytes', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 254, 255]);
    const hex = bytesToHex(bytes);
    expect(hex).toBe('00010f107f80feff');
    expect(hexToBytes(hex)).toEqual(bytes);
  });

  it('returns empty buffer on invalid hex', () => {
    expect(hexToBytes('xyz')).toEqual(new Uint8Array(0));
    expect(hexToBytes('abc')).toEqual(new Uint8Array(0)); // odd length
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('is case-insensitive for hex', () => {
    expect(hexToBytes('DEADBEEF')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});

describe('crypto / timingSafeEqual', () => {
  it('equal buffers compare true', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it('different buffers compare false', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('different lengths return false', () => {
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('two empty buffers compare true', () => {
    expect(timingSafeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe('crypto / HMAC', () => {
  // Test vector from RFC 4231 §4.2
  const rfcKey = 'Jefe';
  const rfcBody = 'what do ya want for nothing?';
  const rfcExpectedSha256 =
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';

  it('matches RFC 4231 test vector for SHA-256', async () => {
    const sig = await hmac(rfcKey, rfcBody, 'SHA-256');
    expect(bytesToHex(sig)).toBe(rfcExpectedSha256);
  });

  it('verifyHmac accepts correct signature (raw hex)', async () => {
    const ok = await verifyHmac(rfcKey, rfcBody, rfcExpectedSha256);
    expect(ok).toBe(true);
  });

  it('verifyHmac accepts Meta-style sha256= prefixed signature', async () => {
    const ok = await verifyHmac(rfcKey, rfcBody, `sha256=${rfcExpectedSha256}`);
    expect(ok).toBe(true);
  });

  it('verifyHmac rejects modified body', async () => {
    const ok = await verifyHmac(rfcKey, 'different body', rfcExpectedSha256);
    expect(ok).toBe(false);
  });

  it('verifyHmac rejects wrong secret', async () => {
    const ok = await verifyHmac('wrong', rfcBody, rfcExpectedSha256);
    expect(ok).toBe(false);
  });

  it('verifyHmac rejects empty signature', async () => {
    expect(await verifyHmac(rfcKey, rfcBody, '')).toBe(false);
    expect(await verifyHmac(rfcKey, rfcBody, 'sha256=')).toBe(false);
  });

  it('verifyHmac rejects malformed hex', async () => {
    expect(await verifyHmac(rfcKey, rfcBody, 'sha256=xyz!')).toBe(false);
  });

  it('verifyHmac rejects missing secret', async () => {
    expect(await verifyHmac('', rfcBody, rfcExpectedSha256)).toBe(false);
  });

  it('works on Uint8Array body', async () => {
    const bytes = new TextEncoder().encode(rfcBody);
    const ok = await verifyHmac(rfcKey, bytes, rfcExpectedSha256);
    expect(ok).toBe(true);
  });
});

describe('crypto / safeStringEqual', () => {
  it('true for equal non-empty strings', () => {
    expect(safeStringEqual('abc', 'abc')).toBe(true);
  });

  it('false for different strings', () => {
    expect(safeStringEqual('abc', 'abd')).toBe(false);
  });

  it('false for empty input', () => {
    expect(safeStringEqual('', 'abc')).toBe(false);
    expect(safeStringEqual('abc', '')).toBe(false);
    expect(safeStringEqual('', '')).toBe(false);
  });

  it('false for unicode-length-different strings', () => {
    // One is ASCII "e", the other is the precomposed Latin-1 "é"
    expect(safeStringEqual('e', 'é')).toBe(false);
  });
});
