import OpenAI from 'openai';

/**
 * OpenAI-compatible client for the reasoning pipeline.
 *
 * Two providers share the same chat-completions wire format:
 *
 *   - OpenAI proper (gpt-4.1, gpt-4.1-mini, gpt-4o-mini)
 *   - DeepSeek (deepseek-v4-pro, deepseek-v4-flash) — via
 *     base_url=https://api.deepseek.com and the DEEPSEEK_API_KEY.
 *
 * Selection happens via the `model` parameter on getReasoningClient —
 * any model name starting with "deepseek-" routes to DeepSeek.
 * That keeps reason.ts free of provider branching: it just asks for
 * a client + sends the same payload.
 *
 * Why DeepSeek: their V4-Pro is benchmarked at gpt-4.1-class quality
 * at ~5× lower cost (limited-time discount through 2026/05/05 makes
 * it ~10× lower), with a 1M-token context window and built-in
 * thinking mode. For Nexus's "see lots of context, decide carefully"
 * workload that's the right tier.
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

let _openaiClient: OpenAI | null = null;
let _deepseekClient: OpenAI | null = null;

/**
 * Return an OpenAI-compatible client routed to whichever provider hosts
 * the requested model. Caches one client per provider per process.
 */
export function getReasoningClient(args: {
  model: string;
  /** Bearer for OpenAI-hosted models. */
  openaiKey?: string;
  /** Bearer for DeepSeek-hosted models. Defaults to env. */
  deepseekKey?: string;
}): { client: OpenAI; provider: 'openai' | 'deepseek' } {
  if (args.model.startsWith('deepseek-')) {
    const key = args.deepseekKey ?? process.env.DEEPSEEK_API_KEY?.trim();
    if (!key) throw new OpenAIError('DEEPSEEK_API_KEY not set');
    if (_deepseekClient) return { client: _deepseekClient, provider: 'deepseek' };
    _deepseekClient = new OpenAI({
      apiKey: key,
      baseURL: 'https://api.deepseek.com',
    });
    return { client: _deepseekClient, provider: 'deepseek' };
  }
  const key = args.openaiKey ?? process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new OpenAIError('OPENAI_API_KEY not set');
  if (_openaiClient) return { client: _openaiClient, provider: 'openai' };
  _openaiClient = new OpenAI({ apiKey: key });
  return { client: _openaiClient, provider: 'openai' };
}

/** Legacy helper kept so existing call sites compile until they migrate. */
export function getOpenAIClient(apiKey: string): OpenAI {
  if (_openaiClient) return _openaiClient;
  _openaiClient = new OpenAI({ apiKey });
  return _openaiClient;
}

export const GPT_4O_MINI = 'gpt-4o-mini';
export const GPT_4_1_MINI = 'gpt-4.1-mini';
export const GPT_4_1 = 'gpt-4.1';
export const DEEPSEEK_V4_PRO = 'deepseek-v4-pro';
export const DEEPSEEK_V4_FLASH = 'deepseek-v4-flash';

/**
 * Default model. DeepSeek V4 Pro at the limited-time 75% discount
 * ($0.435 in / $0.87 out per Mtok) is the cheapest path to
 * gpt-4.1-class reasoning. Override via OPENAI_MODEL env if a future
 * provider beats it.
 */
export const DEFAULT_REASONING_MODEL = DEEPSEEK_V4_PRO;

/**
 * Per-million-token prices. computeOpenAICostUsd picks the right rate
 * based on the model; unknown models fall back to gpt-4o-mini rates so
 * cost-tracking never silently zeros out.
 *
 * DeepSeek prices reflect the limited-time discount through 2026/05/05.
 * After that, V4-Pro reverts to $1.74 / $3.48 (still ~50% cheaper than
 * gpt-4.1). Update these numbers then.
 */
const PRICING_PER_MTOK: Record<string, { in: number; out: number }> = {
  [GPT_4O_MINI]: { in: 0.15, out: 0.6 },
  [GPT_4_1_MINI]: { in: 0.4, out: 1.6 },
  [GPT_4_1]: { in: 2, out: 8 },
  [DEEPSEEK_V4_PRO]: { in: 0.435, out: 0.87 }, // 75% off until 2026-05-05
  [DEEPSEEK_V4_FLASH]: { in: 0.14, out: 0.28 },
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
