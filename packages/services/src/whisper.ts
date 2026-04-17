/**
 * OpenAI Whisper transcription client.
 *
 * Reference: https://platform.openai.com/docs/api-reference/audio/createTranscription
 *
 * Pricing (as of writing): $0.006 / minute of audio, billed per second.
 * We compute `cost_usd` from the `durationSec` we pass in so it appears
 * even on partial responses.
 */

export class WhisperError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WhisperError';
  }
}

const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperResult {
  text: string;
  language?: string;
  segments?: WhisperSegment[];
  durationSec: number;
  /** Cost in USD cents * 1000 — i.e., `cost_usd_millis`. */
  costUsdMillis: number;
  provider: 'whisper';
}

/** $0.006 / minute = $0.0001 / second = 0.1 mill-cents / second. */
const WHISPER_USD_PER_SECOND = 0.0001;

/**
 * Transcribe an audio file. We fetch the bytes from `audioUrl` first
 * (signed R2 URL) and hand them to OpenAI as multipart/form-data.
 *
 * `modelId` is configurable so we can swap to gpt-4o-transcribe without
 * code changes once that provider is GA on the same endpoint.
 */
export async function transcribeWithWhisper(args: {
  apiKey: string;
  audioUrl: string;
  mimeType: string;
  fileName?: string;
  modelId?: string;
  language?: string;
}): Promise<WhisperResult> {
  const { apiKey, audioUrl, mimeType, modelId = 'whisper-1', language } = args;

  const downloadRes = await fetch(audioUrl, { cache: 'no-store' });
  if (!downloadRes.ok) {
    throw new WhisperError(`download audio failed: ${downloadRes.status}`, downloadRes.status);
  }
  const bytes = new Uint8Array(await downloadRes.arrayBuffer());

  const blob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, args.fileName ?? 'audio');
  form.append('model', modelId);
  form.append('response_format', 'verbose_json');
  if (language) form.append('language', language);

  const res = await fetch(WHISPER_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new WhisperError(
      `whisper transcribe failed: ${res.status} ${body.slice(0, 500)}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    text: string;
    language?: string;
    duration?: number;
    segments?: Array<{ start: number; end: number; text: string }>;
  };

  const durationSec = Math.max(0, Math.round(data.duration ?? 0));
  // cost_usd_millis = USD * 100_000  (stored as bigint in our schema)
  const costUsdMillis = Math.round(durationSec * WHISPER_USD_PER_SECOND * 100_000);

  return {
    text: data.text,
    language: data.language,
    segments: data.segments,
    durationSec,
    costUsdMillis,
    provider: 'whisper',
  };
}
