import OpenAI from 'openai';

/**
 * OpenAI client for the reasoning pipeline.
 *
 * Default model: GPT-4.1-mini.
 *   - Input: $0.40 / Mtok
 *   - Output: $1.60 / Mtok
 *   - ~3× the cost of GPT-4o-mini, ~5× the reasoning quality on
 *     update-vs-create decisions and multi-task extraction. Worth it
 *     for the workload Nexus throws at it (~100 sessions/day → ~$11/mo).
 *
 * GPT-4o-mini is kept as a constant for fallback / A/B testing via
 * the `OPENAI_MODEL` env var.
 */

export class OpenAIError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

let _client: OpenAI | null = null;

export function getOpenAIClient(apiKey: string): OpenAI {
  if (_client) return _client;
  _client = new OpenAI({ apiKey });
  return _client;
}

export const GPT_4O_MINI = 'gpt-4o-mini';
export const GPT_4_1_MINI = 'gpt-4.1-mini';
export const GPT_4_1 = 'gpt-4.1';
/** Default model for new reasoning runs unless OPENAI_MODEL is set. */
export const DEFAULT_REASONING_MODEL = GPT_4_1_MINI;

// Per-million token prices for the models we actually use. computeOpenAICostUsd
// picks the right rate based on the requested model — falling back to the
// 4o-mini rates for safety so cost tracking never silently zeros out.
const PRICING_PER_MTOK: Record<string, { in: number; out: number }> = {
  [GPT_4O_MINI]: { in: 0.15, out: 0.6 },
  [GPT_4_1_MINI]: { in: 0.4, out: 1.6 },
  [GPT_4_1]: { in: 2, out: 8 },
};

export function computeOpenAICostUsd(usage: {
  promptTokens: number;
  completionTokens: number;
  model?: string;
}): number {
  const { promptTokens, completionTokens, model } = usage;
  const rate = (model && PRICING_PER_MTOK[model]) || PRICING_PER_MTOK[GPT_4O_MINI]!;
  return (
    (promptTokens / 1_000_000) * rate.in +
    (completionTokens / 1_000_000) * rate.out
  );
}
