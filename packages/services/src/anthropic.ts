import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic client + reasoning helper for Phase 4.
 *
 * Prompt-caching strategy:
 *   - System prompt (template + contact metadata) → `cache_control: ephemeral`
 *     so subsequent calls for the same session re-use the cache (60% off).
 *   - Session transcripts (interactions + audio transcriptions) → sent as
 *     `user` messages each call (these change per turn).
 *
 * Pricing for Sonnet 4.5 (as of writing):
 *   - input:  $3 / Mtok
 *   - cached input: $0.30 / Mtok (90% off base input)
 *   - output: $15 / Mtok
 */

export class AnthropicError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AnthropicError';
  }
}

let _client: Anthropic | null = null;

export function getAnthropicClient(apiKey: string): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey });
  return _client;
}

export const SONNET_4_5 = 'claude-sonnet-4-5-20250929';

// Prices in USD per million tokens (Sonnet 4.5).
const PRICE_IN_PER_MTOK = 3;
const PRICE_CACHE_WRITE_PER_MTOK = 3.75; // 25% markup vs base input
const PRICE_CACHE_READ_PER_MTOK = 0.3; // 90% off
const PRICE_OUT_PER_MTOK = 15;

export function computeClaudeCostUsd(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}): number {
  const {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens = 0,
    cacheReadInputTokens = 0,
  } = usage;
  const base = inputTokens - cacheCreationInputTokens - cacheReadInputTokens;
  return (
    (base / 1_000_000) * PRICE_IN_PER_MTOK +
    (cacheCreationInputTokens / 1_000_000) * PRICE_CACHE_WRITE_PER_MTOK +
    (cacheReadInputTokens / 1_000_000) * PRICE_CACHE_READ_PER_MTOK +
    (outputTokens / 1_000_000) * PRICE_OUT_PER_MTOK
  );
}
