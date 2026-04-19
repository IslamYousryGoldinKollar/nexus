import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { computeClaudeCostUsd, getAnthropicClient, SONNET_4_5 } from './anthropic.js';

/**
 * Phase 4 — Reason over a session context with Claude Sonnet 4.5.
 *
 * The system prompt is split into two blocks:
 *   1. Static Nexus persona + rules (ephemeral cached — same for every call)
 *   2. Output-schema description (also cached)
 *
 * The user message embeds the session transcript fresh every call. On a
 * hot cache this keeps cost ~85% off the naive prompt-each-time price.
 */

// ---- Input shape --------------------------------------------------------

export interface ReasonContext {
  sessionId: string;
  openedAt: string;
  lastActivityAt: string;
  contact: {
    id: string;
    displayName: string;
    identifiers: Array<{ kind: string; value: string }>;
    notes?: string | null;
  } | null;
  account: { id: string; name: string; domain?: string | null } | null;
  interactions: Array<{
    id: string;
    channel: string;
    direction: string;
    contentType: string;
    occurredAt: string;
    text?: string | null;
    transcriptText?: string | null;
  }>;
}

// ---- Output schema ------------------------------------------------------

export const proposedTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  priority: z.enum(['low', 'med', 'high', 'urgent']).default('med'),
  assigneeGuess: z.string().nullable().optional(),
  dueDateGuess: z.string().datetime().nullable().optional(),
  rationale: z.string().min(1).max(2000),
  evidence: z
    .array(
      z.object({
        interactionId: z.string(),
        quote: z.string().min(1).max(500),
      }),
    )
    .default([]),
});
export type ProposedTaskDraft = z.infer<typeof proposedTaskSchema>;

export const reasonOutputSchema = z.object({
  proposedTasks: z.array(proposedTaskSchema).max(10),
  summary: z.string().max(800).optional(),
});
export type ReasonOutput = z.infer<typeof reasonOutputSchema>;

// ---- Prompts ------------------------------------------------------------

const NEXUS_PERSONA = `You are Nexus, the AI Chief of Staff for Islam Yousry at GoldinKollar.
Your only job is to look at client-communication sessions (WhatsApp, Gmail,
Telegram, phone call transcripts, Teams messages) and propose zero to five
concrete follow-up tasks that Islam should add to Injaz, his task manager.

Hard rules you must NEVER violate:
  - You never send messages to clients directly. Everything you produce is
    a proposal for Islam to approve.
  - You never invent facts. Every task you propose MUST cite at least one
    evidence quote from the session with its interactionId.
  - You never create a task if no follow-up is needed. Returning zero tasks
    is the right answer when the conversation was chitchat, already
    resolved, or information-only.
  - Tasks must be actionable by ONE person within a week. Split anything
    bigger; omit anything vaguer.
  - If due date is genuinely unclear, set dueDateGuess to null. Do not
    guess from vibes.
  - Write tasks in the language the client used (if they wrote in Arabic,
    write the task in Arabic).`;

const OUTPUT_CONTRACT = `You must respond with ONLY a single JSON object matching this TypeScript type:

{
  "summary": string,          // optional 1–3 sentence summary of the session
  "proposedTasks": Array<{
    "title": string,          // ≤ 200 chars, imperative: "Send revised proposal to Ahmed"
    "description": string,    // ≤ 4000 chars; what exactly to do
    "priority": "low" | "med" | "high" | "urgent",
    "assigneeGuess": string | null,  // if not Islam, name or role; else null
    "dueDateGuess": string | null,   // ISO 8601 datetime or null
    "rationale": string,      // why this task is the right call
    "evidence": Array<{
      "interactionId": string, // uuid you saw in the input
      "quote": string          // the exact phrase from the session
    }>
  }>
}

Output rules:
  - Return STRICTLY valid JSON. No prose, no markdown, no code fences.
  - evidence MUST reference real interactionIds from this session.
  - If there is no follow-up, return { "proposedTasks": [] }.`;

function buildContactHeader(ctx: ReasonContext): string {
  if (!ctx.contact) return '(Unknown contact — identity not yet resolved)';
  const parts = [
    `Contact: ${ctx.contact.displayName}`,
    ctx.account ? `Account: ${ctx.account.name}` : null,
    ctx.contact.identifiers.length
      ? `Identifiers: ${ctx.contact.identifiers.map((i) => `${i.kind}=${i.value}`).join(', ')}`
      : null,
    ctx.contact.notes ? `Notes: ${ctx.contact.notes}` : null,
  ].filter(Boolean);
  return parts.join('\n');
}

function buildSessionBody(ctx: ReasonContext): string {
  const header = `Session ${ctx.sessionId} (opened ${ctx.openedAt}, last activity ${ctx.lastActivityAt}).`;
  const contactBlock = buildContactHeader(ctx);
  const interactionLines = ctx.interactions.map((i, idx) => {
    const body =
      i.transcriptText && i.transcriptText.length > 0
        ? `[transcript] ${i.transcriptText}`
        : (i.text ?? '(no text body)');
    return `[${idx + 1}] id=${i.id} ${i.channel}/${i.contentType} (${i.direction}) @ ${i.occurredAt}\n    ${body.replace(/\n/g, '\n    ')}`;
  });
  return [header, contactBlock, '', 'Interactions (chronological):', ...interactionLines].join('\n');
}

// ---- Main entry ---------------------------------------------------------

export interface ReasonCallResult {
  output: ReasonOutput;
  rawResponse: Anthropic.Messages.Message;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export async function reasonOverSession(args: {
  apiKey: string;
  model?: string;
  context: ReasonContext;
  maxTokens?: number;
}): Promise<ReasonCallResult> {
  const { apiKey, model = SONNET_4_5, context, maxTokens = 2048 } = args;

  const client = getAnthropicClient(apiKey);
  const userBody = buildSessionBody(context);

  const start = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: NEXUS_PERSONA, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: OUTPUT_CONTRACT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: userBody,
          },
        ],
      },
    ],
  });
  const latencyMs = Date.now() - start;

  // Extract the first text block.
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude response had no text block');
  }
  const raw = textBlock.text.trim();

  // The contract says no code fences; defensive strip anyway.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: ReasonOutput;
  try {
    const jsonish = JSON.parse(stripped);
    parsed = reasonOutputSchema.parse(jsonish);
  } catch (err) {
    throw new Error(
      `reason output invalid: ${(err as Error).message}\nraw: ${raw.slice(0, 500)}`,
    );
  }

  const usage = response.usage;
  const costUsd = computeClaudeCostUsd({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  });

  return {
    output: parsed,
    rawResponse: response,
    costUsd,
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    latencyMs,
  };
}
