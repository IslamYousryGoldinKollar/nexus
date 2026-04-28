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

  // OpenAI detects file format from the *filename extension* (not
  // Content-Type). Supported: flac, m4a, mp3, mp4, mpeg, mpga, oga,
  // ogg, wav, webm. We can't trust the upstream MIME (Android's
  // DocumentsContract regularly mislabels .m4a as audio/mpeg), so
  // sniff the actual byte signature first; only fall back to the
  // declared MIME when the signature is unrecognised.
  const sniffed = sniffAudioExtension(bytes);
  const extFromMime = sniffed ?? (() => {
    const m = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (m.includes('ogg')) return 'ogg';
    if (m.includes('mp4')) return 'mp4';
    if (m.includes('mpeg')) return 'mp3';
    if (m.includes('mp3')) return 'mp3';
    if (m.includes('wav') || m.includes('wave')) return 'wav';
    if (m.includes('webm')) return 'webm';
    if (m.includes('flac')) return 'flac';
    if (m.includes('m4a') || m.includes('aac')) return 'm4a';
    return 'ogg'; // sensible default for WhatsApp
  })();
  const fileName = args.fileName ?? `audio.${extFromMime}`;

  const blob = new Blob([bytes], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, fileName);
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

/**
 * Recognise the audio container format from the first dozen bytes.
 * Returns the OpenAI-Whisper-compatible extension when confident,
 * else null so the caller falls back to the declared MIME.
 *
 * Signatures we handle:
 *   - M4A / MP4 / 3GP — `....ftyp<brand>` at offset 4 (ISO BMFF)
 *   - Ogg (Vorbis, Opus) — `OggS` magic
 *   - WAV — `RIFF....WAVE`
 *   - WebM / Matroska — EBML header `1A 45 DF A3`
 *   - FLAC — `fLaC` magic
 *   - MP3 — ID3 tag (`ID3`) or sync word (0xFF E0+)
 *
 * Anything else returns null. We deliberately don't return `mp4`
 * for `ftyp` because Whisper treats `.m4a` and `.mp4` differently
 * for some sub-brands and `.m4a` is the safer pick for audio-only.
 */
function sniffAudioExtension(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // ISO BMFF (M4A / MP4 / 3GP): "ftyp" at bytes 4..8
  if (
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70    // p
  ) {
    return 'm4a';
  }
  // OggS
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'ogg';
  }
  // RIFF....WAVE
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
  ) {
    return 'wav';
  }
  // Matroska / WebM EBML header
  if (
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  ) {
    return 'webm';
  }
  // FLAC
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return 'flac';
  }
  // MP3: ID3 tag
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'mp3';
  }
  // MP3: sync word (0xFF then 0xE0..0xFF)
  if (bytes[0] === 0xff && (bytes[1] !== undefined) && (bytes[1] & 0xe0) === 0xe0) {
    return 'mp3';
  }
  return null;
}
