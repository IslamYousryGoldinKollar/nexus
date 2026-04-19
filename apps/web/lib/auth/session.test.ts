import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Force a deterministic AUTH_SECRET before importing the module.
const ORIGINAL_SECRET = process.env.AUTH_SECRET;
process.env.AUTH_SECRET = 'test-secret-at-least-16-characters-long';

const { createSessionJwt, verifySessionJwt } = await import('./session');

describe('session JWT', () => {
  it('issues a JWT that round-trips', async () => {
    const jwt = await createSessionJwt('Islam.Yousry@goldinkollar.com');
    const payload = await verifySessionJwt(jwt);
    expect(payload).not.toBeNull();
    expect(payload?.email).toBe('islam.yousry@goldinkollar.com');
    expect(payload?.role).toBe('admin');
    expect(payload?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('returns null for a tampered JWT', async () => {
    const jwt = await createSessionJwt('a@b.com');
    const tampered = jwt.slice(0, -3) + 'xyz';
    expect(await verifySessionJwt(tampered)).toBeNull();
  });

  it('returns null for an empty / nonsense token', async () => {
    expect(await verifySessionJwt('')).toBeNull();
    expect(await verifySessionJwt('not-a-jwt')).toBeNull();
  });
});

afterEach(() => {
  // Tests in this file mutate process.env so reset for any followups.
  if (ORIGINAL_SECRET === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIGINAL_SECRET;
  // Re-set immediately for next test in this same file.
  process.env.AUTH_SECRET = 'test-secret-at-least-16-characters-long';
});

beforeAll(() => {
  process.env.AUTH_SECRET = 'test-secret-at-least-16-characters-long';
});
