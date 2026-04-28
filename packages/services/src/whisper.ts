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
  const rawBytes = new Uint8Array(await downloadRes.arrayBuffer());

  // OpenAI detects file format from the *filename extension* (not
  // Content-Type). Supported: flac, m4a, mp3, mp4, mpeg, mpga, oga,
  // ogg, wav, webm. We can't trust the upstream MIME (Android's
  // DocumentsContract regularly mislabels .m4a as audio/mpeg), so
  // sniff the actual byte signature first; only fall back to the
  // declared MIME when the signature is unrecognised.
  //
  // For ISO BMFF files (anything with `ftyp`), Whisper's MP4/M4A
  // decoders are *brand-aware* — they reject `3gp4`/`3gp5`/`qt  `
  // even when the codec inside is regular AAC. Empirically the only
  // way to get Whisper to accept these is to rewrite the major brand
  // to `M4A ` and send with `.m4a`. The codec bitstream (`mp4a`) is
  // already valid; we're just relabeling the container header.
  const { bytes, ext } = normaliseForWhisper(rawBytes, mimeType);
  const fileName = args.fileName ?? `audio.${ext}`;

  // Send with a generic content type — extension is what Whisper reads.
  // Cast through Uint8Array<ArrayBuffer> to satisfy lib.dom's BlobPart.
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: ext === 'm4a' ? 'audio/m4a' : mimeType,
  });
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
 * Pick the right extension for Whisper, and rewrite the ISO BMFF
 * `ftyp` major brand when needed so Whisper's M4A decoder accepts
 * the file.
 *
 * Whisper's accepted formats: flac, m4a, mp3, mp4, mpeg, mpga, oga,
 * ogg, wav, webm. The catch: for ISO BMFF containers (anything with
 * `ftyp` at offset 4) Whisper inspects the *major brand* and rejects
 * `3gp4` / `3gp5` / `3g2a` / `qt  ` with "Invalid file format" even
 * when the codec inside is plain AAC (`mp4a`). Empirically:
 *   - `M4A ` / `M4B ` / `M4P ` brands → accepted as `.m4a`
 *   - `mp42` / `isom` / `mp41` brands → accepted as `.mp4`
 *   - everything else → rejected with EVERY extension
 *
 * Android's native call recorder (Pixel/Samsung from 14+) writes
 * `3gp4` despite muxing AAC, which is what shows up in the wild.
 * Renaming the file is not enough — Whisper reads the brand bytes,
 * not just the filename.
 *
 * Fix: when we see a non-M4A `ftyp` brand wrapping AAC, rewrite the
 * brand bytes in-place to `M4A ` (and the matching compat brand to
 * `mp41`) and send as `.m4a`. The `mp4a` codec bitstream is already
 * valid; we're just relabeling the container header. Confirmed
 * working with real 3gp4-branded recordings from Android.
 *
 * Other containers (Ogg, WAV, WebM, FLAC, MP3) pass through unchanged.
 */
function normaliseForWhisper(
  input: Uint8Array,
  mimeType: string,
): { bytes: Uint8Array; ext: string } {
  if (input.length >= 12 && isFtyp(input)) {
    const brand = readBrand(input, 8);
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') {
      return { bytes: input, ext: 'm4a' };
    }
    if (brand === 'mp41' || brand === 'mp42' || brand === 'isom') {
      // Whisper accepts these natively as .mp4. Could also relabel to
      // M4A — both work — but leave as-is to minimise byte mutation.
      return { bytes: input, ext: 'mp4' };
    }
    // Anything else (3gp4, 3gp5, 3g2a, qt, mp4a-as-brand, …): copy
    // bytes (don't mutate the caller's buffer) and rewrite the major
    // brand to M4A and any 3gp* in compat list to mp41. Whisper then
    // accepts as .m4a. We keep `isom` if present in compat — that's
    // already friendly.
    const out = new Uint8Array(input);
    writeBrand(out, 8, 'M4A ');
    // Rewrite compat brands at offsets 16, 20, 24 ... up to end of
    // ftyp box (size at offset 0..3, big-endian).
    const ftypSize = readU32BE(out, 0);
    for (let off = 16; off + 4 <= ftypSize && off + 4 <= out.length; off += 4) {
      const b = readBrand(out, off);
      if (b.startsWith('3g') || b === 'qt  ') {
        writeBrand(out, off, 'mp41');
      }
    }
    return { bytes: out, ext: 'm4a' };
  }
  // OggS
  if (input[0] === 0x4f && input[1] === 0x67 && input[2] === 0x67 && input[3] === 0x53) {
    return { bytes: input, ext: 'ogg' };
  }
  // RIFF....WAVE
  if (
    input.length >= 12 &&
    input[0] === 0x52 && input[1] === 0x49 && input[2] === 0x46 && input[3] === 0x46 &&
    input[8] === 0x57 && input[9] === 0x41 && input[10] === 0x56 && input[11] === 0x45
  ) {
    return { bytes: input, ext: 'wav' };
  }
  // Matroska / WebM EBML header
  if (input[0] === 0x1a && input[1] === 0x45 && input[2] === 0xdf && input[3] === 0xa3) {
    return { bytes: input, ext: 'webm' };
  }
  // FLAC
  if (input[0] === 0x66 && input[1] === 0x4c && input[2] === 0x61 && input[3] === 0x43) {
    return { bytes: input, ext: 'flac' };
  }
  // MP3: ID3 tag, or sync word (0xFF then 0xE0..0xFF)
  if (input[0] === 0x49 && input[1] === 0x44 && input[2] === 0x33) {
    return { bytes: input, ext: 'mp3' };
  }
  if (input[0] === 0xff && input[1] !== undefined && (input[1] & 0xe0) === 0xe0) {
    return { bytes: input, ext: 'mp3' };
  }
  // Unknown signature — fall back to the declared MIME.
  const m = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  let ext = 'ogg'; // sensible default for WhatsApp
  if (m.includes('ogg')) ext = 'ogg';
  else if (m.includes('mp4')) ext = 'mp4';
  else if (m.includes('mpeg') || m.includes('mp3')) ext = 'mp3';
  else if (m.includes('wav') || m.includes('wave')) ext = 'wav';
  else if (m.includes('webm')) ext = 'webm';
  else if (m.includes('flac')) ext = 'flac';
  else if (m.includes('m4a') || m.includes('aac')) ext = 'm4a';
  return { bytes: input, ext };
}

function isFtyp(b: Uint8Array): boolean {
  return (
    b[4] === 0x66 && // f
    b[5] === 0x74 && // t
    b[6] === 0x79 && // y
    b[7] === 0x70    // p
  );
}

function readBrand(b: Uint8Array, off: number): string {
  return String.fromCharCode(
    b[off] ?? 0,
    b[off + 1] ?? 0,
    b[off + 2] ?? 0,
    b[off + 3] ?? 0,
  );
}

function writeBrand(b: Uint8Array, off: number, brand: string): void {
  b[off] = brand.charCodeAt(0);
  b[off + 1] = brand.charCodeAt(1);
  b[off + 2] = brand.charCodeAt(2);
  b[off + 3] = brand.charCodeAt(3);
}

function readU32BE(b: Uint8Array, off: number): number {
  return (
    ((b[off] ?? 0) << 24) |
    ((b[off + 1] ?? 0) << 16) |
    ((b[off + 2] ?? 0) << 8) |
    (b[off + 3] ?? 0)
  ) >>> 0;
}
