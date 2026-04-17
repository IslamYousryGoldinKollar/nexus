import { describe, expect, it } from 'vitest';
import { phoneUploadMetaSchema } from './schema';

describe('phone upload meta schema', () => {
  const valid = {
    counterparty: '+201234567890',
    direction: 'inbound',
    startedAt: '2026-01-15T10:30:00.000Z',
    durationSec: 180,
    callId: '5f0a3f34-5c9c-4d5e-8a1b-1b9f2e3a4c5d',
    recorder: 'CubeACR',
    transcribe: true,
  };

  it('accepts a valid metadata object', () => {
    const res = phoneUploadMetaSchema.safeParse(valid);
    expect(res.success).toBe(true);
  });

  it('coerces string numeric durationSec', () => {
    const res = phoneUploadMetaSchema.safeParse({ ...valid, durationSec: '180' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.durationSec).toBe(180);
  });

  it('rejects non-E.164 counterparty', () => {
    const res = phoneUploadMetaSchema.safeParse({
      ...valid,
      counterparty: '012-3456-7890',
    });
    expect(res.success).toBe(false);
  });

  it('rejects invalid direction', () => {
    const res = phoneUploadMetaSchema.safeParse({ ...valid, direction: 'both' });
    expect(res.success).toBe(false);
  });

  it('rejects non-ISO startedAt', () => {
    const res = phoneUploadMetaSchema.safeParse({ ...valid, startedAt: '2026/01/15' });
    expect(res.success).toBe(false);
  });

  it('rejects negative duration', () => {
    const res = phoneUploadMetaSchema.safeParse({ ...valid, durationSec: -1 });
    expect(res.success).toBe(false);
  });

  it('defaults transcribe=true when omitted', () => {
    const { transcribe: _t, ...withoutTranscribe } = valid;
    const res = phoneUploadMetaSchema.safeParse(withoutTranscribe);
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.transcribe).toBe(true);
  });
});
