import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('phone upload authorization', () => {
  const originalKeys = process.env.PHONE_INGEST_API_KEYS;
  const originalDbUrl = process.env.DATABASE_URL;
  const originalAppUrl = process.env.APP_URL;

  beforeEach(() => {
    // Minimum env for `parseServerEnv` to succeed.
    process.env.DATABASE_URL = 'postgres://user:pass@host.example.com:6543/db';
    process.env.APP_URL = 'http://localhost:3000';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalKeys === undefined) delete process.env.PHONE_INGEST_API_KEYS;
    else process.env.PHONE_INGEST_API_KEYS = originalKeys;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
    vi.resetModules();
  });

  const req = (authz?: string) => {
    const headers = new Headers();
    if (authz) headers.set('authorization', authz);
    return new Request('https://example.test/api/ingest/phone', {
      method: 'POST',
      headers,
    });
  };

  it('rejects when no keys are configured', async () => {
    process.env.PHONE_INGEST_API_KEYS = '';
    const { authorizePhoneUpload } = await import('./auth');
    expect(authorizePhoneUpload(req('Bearer whatever'))).toEqual({
      ok: false,
      reason: 'ingest_disabled',
    });
  });

  it('rejects when authorization header is missing', async () => {
    process.env.PHONE_INGEST_API_KEYS = 'secret123';
    const { authorizePhoneUpload } = await import('./auth');
    expect(authorizePhoneUpload(req()).ok).toBe(false);
    expect(authorizePhoneUpload(req()).reason).toBe('missing_bearer');
  });

  it('accepts a matching bearer token', async () => {
    process.env.PHONE_INGEST_API_KEYS = 'secret123,secret456';
    const { authorizePhoneUpload } = await import('./auth');
    expect(authorizePhoneUpload(req('Bearer secret456')).ok).toBe(true);
  });

  it('rejects a mismatched bearer token', async () => {
    process.env.PHONE_INGEST_API_KEYS = 'secret123,secret456';
    const { authorizePhoneUpload } = await import('./auth');
    const res = authorizePhoneUpload(req('Bearer secret999'));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('key_mismatch');
  });

  it('is case-insensitive on the "bearer" scheme', async () => {
    process.env.PHONE_INGEST_API_KEYS = 'secret';
    const { authorizePhoneUpload } = await import('./auth');
    expect(authorizePhoneUpload(req('bearer secret')).ok).toBe(true);
    expect(authorizePhoneUpload(req('BEARER secret')).ok).toBe(true);
  });
});
