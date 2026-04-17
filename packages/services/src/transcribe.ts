import {
  transcribeWithAssemblyAI,
  type AssemblyAIResult,
} from './assemblyai.js';
import { transcribeWithWhisper, type WhisperResult } from './whisper.js';

/**
 * Provider-agnostic transcription wrapper.
 *
 * Decision rule (Phase 3):
 *   - Explicit caller override → honour it
 *   - content_type === 'call' AND ASSEMBLYAI_API_KEY set → AssemblyAI (diarization)
 *   - otherwise → Whisper
 */

export type TranscriptionResult = WhisperResult | AssemblyAIResult;

export interface TranscribeArgs {
  audioUrl: string;
  mimeType: string;
  fileName?: string;
  language?: string;
  preferredProvider?: 'whisper' | 'assemblyai';
  isMultiSpeaker?: boolean;
}

export async function transcribe(args: TranscribeArgs): Promise<TranscriptionResult> {
  const { audioUrl, mimeType, fileName, language, preferredProvider, isMultiSpeaker } = args;

  const whisperKey = process.env.OPENAI_API_KEY;
  const assemblyKey = process.env.ASSEMBLYAI_API_KEY;

  const useAssembly =
    preferredProvider === 'assemblyai' || (isMultiSpeaker && !!assemblyKey);

  if (useAssembly) {
    if (!assemblyKey) throw new Error('ASSEMBLYAI_API_KEY missing for multi-speaker transcription');
    return transcribeWithAssemblyAI({ apiKey: assemblyKey, audioUrl });
  }

  if (!whisperKey) throw new Error('OPENAI_API_KEY missing for Whisper transcription');
  return transcribeWithWhisper({
    apiKey: whisperKey,
    audioUrl,
    mimeType,
    fileName,
    language,
  });
}
