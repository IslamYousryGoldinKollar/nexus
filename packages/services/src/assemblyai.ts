/**
 * AssemblyAI client — used when we need speaker diarization.
 *
 * AssemblyAI's "nano" model is roughly the same cost as Whisper ($0.12/hour ≈
 * $0.002/min) with diarization native. We reach for it only when the
 * content_type is `call` or the interaction is suspected multi-speaker.
 *
 * Reference: https://www.assemblyai.com/docs/api-reference/transcripts
 */

export class AssemblyAIError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AssemblyAIError';
  }
}

const BASE = 'https://api.assemblyai.com';

export interface AssemblyAISegment {
  speaker?: string;
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export interface AssemblyAIResult {
  text: string;
  language?: string;
  segments: AssemblyAISegment[];
  durationSec: number;
  /** mill-cents USD — see schema transcripts.cost_usd_millis */
  costUsdMillis: number;
  provider: 'assemblyai';
}

// AssemblyAI async billing is ~$0.002 / minute ≈ $0.000033 / second for nano model.
const ASSEMBLYAI_USD_PER_SECOND = 0.0000333;

interface TranscriptObject {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  language_code?: string;
  audio_duration?: number;
  error?: string;
  utterances?: Array<{
    speaker: string;
    start: number; // ms
    end: number;   // ms
    text: string;
  }>;
}

/**
 * Submit + poll for an AssemblyAI transcript.
 *
 * For Inngest invocations we poll synchronously for up to `pollTimeoutMs`;
 * Phase 11 will convert this to an Inngest `sleep` loop to release the
 * function slot while waiting.
 */
export async function transcribeWithAssemblyAI(args: {
  apiKey: string;
  audioUrl: string;
  pollTimeoutMs?: number;
}): Promise<AssemblyAIResult> {
  const { apiKey, audioUrl, pollTimeoutMs = 10 * 60 * 1000 } = args;

  const submit = await fetch(`${BASE}/v2/transcript`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speaker_labels: true,
      speech_model: 'nano',
    }),
  });
  if (!submit.ok) {
    const body = await submit.text().catch(() => '');
    throw new AssemblyAIError(
      `assemblyai submit failed: ${submit.status} ${body.slice(0, 500)}`,
      submit.status,
    );
  }
  const submitted = (await submit.json()) as { id: string };
  const transcriptId = submitted.id;

  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/v2/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
      cache: 'no-store',
    });
    if (!r.ok) {
      throw new AssemblyAIError(`assemblyai poll failed: ${r.status}`, r.status);
    }
    const body = (await r.json()) as TranscriptObject;
    if (body.status === 'completed') {
      const durationSec = Math.max(0, Math.round(body.audio_duration ?? 0));
      const segments: AssemblyAISegment[] =
        body.utterances?.map((u) => ({
          speaker: u.speaker,
          start: u.start / 1000,
          end: u.end / 1000,
          text: u.text,
        })) ?? [];
      return {
        text: body.text ?? '',
        language: body.language_code,
        segments,
        durationSec,
        costUsdMillis: Math.round(durationSec * ASSEMBLYAI_USD_PER_SECOND * 100_000),
        provider: 'assemblyai',
      };
    }
    if (body.status === 'error') {
      throw new AssemblyAIError(`assemblyai error: ${body.error ?? 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new AssemblyAIError(`assemblyai poll timeout after ${pollTimeoutMs}ms`);
}
