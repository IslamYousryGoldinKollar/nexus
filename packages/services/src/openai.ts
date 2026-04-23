import OpenAI from 'openai';

/**
 * OpenAI client for Phase 4 reasoning.
 *
 * Using GPT-4o-mini for cost-effective reasoning:
 *   - Input: $0.15 / Mtok
 *   - Output: $0.60 / Mtok
 *   - ~20x cheaper than Claude Sonnet 4.5
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

// Prices in USD per million tokens (GPT-4o-mini)
const PRICE_IN_PER_MTOK = 0.15;
const PRICE_OUT_PER_MTOK = 0.60;

export function computeOpenAICostUsd(usage: {
  promptTokens: number;
  completionTokens: number;
}): number {
  const { promptTokens, completionTokens } = usage;
  return (
    (promptTokens / 1_000_000) * PRICE_IN_PER_MTOK +
    (completionTokens / 1_000_000) * PRICE_OUT_PER_MTOK
  );
}
