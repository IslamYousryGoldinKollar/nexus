import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import { z } from 'zod';
import { computeClaudeCostUsd, getAnthropicClient, SONNET_4_5 } from './anthropic.js';
import {
  computeOpenAICostUsd,
  getReasoningClient,
  DEFAULT_REASONING_MODEL,
} from './openai.js';

/**
 * Phase 4 — Reason over a session context with Claude Sonnet 4.5 or GPT-4o-mini (OpenAI).
 *
 * Default provider is OpenAI for cost savings (~20x cheaper).
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
  /**
   * Open Injaz tasks already attached to this contact's client/project.
   * The model uses these to decide "this is an update to task X" vs
   * "new task" — without this context every meeting would generate
   * duplicate to-dos for work already on the board.
   */
  existingInjazTasks?: Array<{
    id: string;
    title: string;
    description?: string | null;
    status: string;
    priority?: string | null;
    dueDate?: string | null;
    assigneeName?: string | null;
    projectName?: string | null;
  }>;
  /**
   * Active Injaz projects for this client (with how many open tasks
   * each carries + who's been working on them most). Helps the AI
   * pick a likely projectName + assignee when the conversation
   * doesn't name them explicitly.
   */
  clientProjects?: Array<{
    name: string;
    openTaskCount: number;
    description?: string | null;
    leadAssigneeName?: string | null;
  }>;
  /**
   * Open task count per Injaz user. The reasoner uses this to suggest
   * the least-loaded approved employee when the message doesn't name
   * an assignee.
   */
  assigneeWorkload?: Array<{
    name: string;
    openTasks: number;
  }>;
  /**
   * Previous sessions for this contact + what tasks they produced.
   * Provides relationship history without dumping full transcripts.
   */
  pastSessions?: Array<{
    openedAt: string;
    state: string;
    summary?: string | null;
    proposedTitles: Array<{ title: string; state: string }>;
  }>;
  /**
   * Full snapshot of the company's clients (with the contact person
   * Injaz has on file). Used by the reasoner to (a) recognise who's
   * on the other end and write tasks like "Send X to {client name}
   * (contact: {person})", and (b) auto-correct names that Whisper
   * mangled — "Merna" against the known "Mirna Sherif", etc.
   */
  knownClients?: Array<{
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
  }>;
  /**
   * All Injaz users (employees) with role + approval status. Used to
   * route the assigneeGuess to a real person on the team rather than
   * a free-text guess.
   */
  knownEmployees?: Array<{
    name: string;
    email: string;
    role: string;
  }>;
}

// ---- Output schema ------------------------------------------------------

/**
 * Forgiving date parser for proposedTask.startDateGuess / dueDateGuess.
 *
 * The model is prompted to return ISO 8601 but in practice returns a
 * mix of formats — `2026-04-28`, `2026-04-28T09:00`, occasionally even
 * `"first thing in the morning"`. Rejecting the entire response on a
 * malformed date used to drop perfectly good tasks on the floor.
 *
 * This preprocessor accepts:
 *   - empty / null / undefined           → null
 *   - already-valid ISO datetime         → pass through
 *   - `YYYY-MM-DD`                       → start of day UTC
 *   - `YYYY-MM-DDTHH:MM` (no seconds/Z)  → assume :00Z
 *   - `YYYY-MM-DDTHH:MM:SS` (no Z)       → assume Z
 *   - anything else                      → null (downstream = "no guess")
 *
 * Output is always either a valid RFC3339 datetime string or null.
 */
const dateGuessSchema = z
  .preprocess((v) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    // Already a valid ISO datetime? Date.parse handles it; round-trip
    // through Date to canonicalise (drops fractional seconds, etc.).
    const direct = Date.parse(s);
    if (!Number.isNaN(direct)) {
      // Be strict-ish: only accept if the string at least starts with a
      // 4-digit year to avoid `Date.parse('first')` style coincidences.
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        return new Date(direct).toISOString();
      }
    }
    // Date-only: YYYY-MM-DD → start of day UTC.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const t = Date.parse(s + 'T00:00:00Z');
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    // Date + HH:MM (no seconds, no zone) → assume Z.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
      const t = Date.parse(s + ':00Z');
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    // Date + HH:MM:SS (no zone) → assume Z.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
      const t = Date.parse(s + 'Z');
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    return null;
  }, z.string().datetime().nullable())
  .optional();

export const proposedTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  priority: z
    .preprocess((v) => {
      if (typeof v !== 'string') return v;
      const lower = v.toLowerCase();
      // The model occasionally emits longer synonyms despite the prompt.
      if (lower === 'medium' || lower === 'normal' || lower === 'mid') return 'med';
      if (lower === 'critical' || lower === 'p0') return 'urgent';
      return lower;
    }, z.enum(['low', 'med', 'high', 'urgent']))
    .default('med'),
  assigneeGuess: z.string().nullable().optional(),
  // Date guesses: prompt asks for ISO 8601, but the model regularly
  // returns date-only (`2026-04-28`) or natural language ("first
  // thing in the morning") and rejecting the whole response on a
  // bad date drops a real task on the floor. Coerce permissively:
  //   - valid ISO datetime → pass through
  //   - YYYY-MM-DD          → 00:00:00Z that day
  //   - YYYY-MM-DDTHH:MM    → assume seconds=00, append Z
  //   - everything else     → null (downstream treats as "no guess")
  startDateGuess: dateGuessSchema,
  dueDateGuess: dateGuessSchema,
  /**
   * Set ONLY when the AI has determined this proposal updates an
   * existing Injaz task (the id must come from the existingInjazTasks
   * the model was shown). Null/undefined = create a new task.
   */
  existingInjazTaskId: z.string().nullable().optional(),
  /**
   * When the conversation clearly references a CLIENT that isn't in
   * the Known-Clients block, the AI sets this to the canonical name
   * we should create. Sync calls MCP create_party (type=CLIENT)
   * before create_task. Leave null for chitchat / unclear cases —
   * we'd rather miss a client than create garbage rows.
   */
  createNewClient: z.string().min(2).max(120).nullable().optional(),
  /**
   * When the conversation is about new work that doesn't match any
   * Active Project for the (existing or new) client, the AI proposes
   * a project name here. Sync calls MCP create_project linking to
   * the client and uses this name as projectName on the task.
   */
  createNewProject: z.string().min(2).max(160).nullable().optional(),
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
Telegram, phone call transcripts, Teams meeting recordings) and propose
ZERO TO TEN concrete follow-up tasks that Islam should add to Injaz, his
task manager.

Important calibration on TASK COUNT — many sessions warrant MULTIPLE
tasks, not just one:

  - A 10-minute call covering 4 separate deliverables → 4 tasks.
  - A meeting that ends with three distinct asks ("send the PPP",
    "schedule kickoff with Mokhtar", "share the design timeline")
    → 3 tasks.
  - A single voice note asking for one specific thing → 1 task.
  - Casual pleasantries / a question Islam already answered → 0 tasks.

Do NOT artificially collapse multiple distinct asks into one task to
look concise. Each task is a single deliverable assignable to ONE
person. If the conversation has six distinct asks, return six tasks
(or split if any one of them is itself bigger than a week's work).

How to think before producing the JSON (do this internally, do NOT
include it in the output):

  Step 1 — Whisper-correction pass. Voice-note transcripts come from
           OpenAI Whisper which sometimes mishears proper names. The
           "Known clients" and "Known employees" blocks list the real
           spellings. If a transcript contains a name that's a near
           match (e.g. "Merna" → "Mirna Sherif", "Hassan Aalam" →
           "Hassan Allam Holding"), MENTALLY substitute the correct
           spelling everywhere before reasoning. Use the corrected
           name in titles and descriptions.

  Step 2 — Was the deliverable already provided? Islam ALWAYS replies
           to clients — that's his job, so just seeing an outbound
           message means nothing. What you're checking for is whether
           the actual concrete thing the client asked for has been
           given. The two patterns:

             Information request — client asked for an answer.
             ZERO tasks if Islam's outbound contains the actual
             answer (price quoted, date confirmed, address given,
             yes/no decision made). STILL a task if Islam only
             acknowledged ("OK I'll get back to you", "let me check").

             Deliverable request — client asked for a file, design,
             quote, document, etc. ZERO tasks ONLY if there is hard
             evidence the deliverable shipped: a file attachment in
             the outbound, a link to the artifact, or wording like
             "attached/مرفق", "here you go/اتفضل", "sent above".
             STILL a task if Islam only promised ("هابعتلك", "I'll
             send", "noted, will share"). Promises ≠ delivery.

             Client-promised deliverable (CHASE pattern) — sometimes
             the CLIENT commits to sending Islam something ("هرسل
             لحضرتك المنيو", "I'll forward you the doc", "بعتهالك
             النهاردة"). Create a follow-up task in this case too:
             title in the form "Chase {client} for {what they promised}".
             Default dueDateGuess to whatever timeframe they named
             ("today/النهاردة" → today, "tomorrow/بكرة" → tomorrow,
             "this week" → +5d), else +2 business days. Assignee
             defaults to Islam. Skip only if Islam's outbound shows
             they already delivered.

             Meeting / call requests — if a client proposes a specific
             time ("call at 12:00", "Tuesday 3pm Cairo time") and
             Islam hasn't yet confirmed in writing, create a task
             "Confirm call with {client} at {time}". If Islam already
             replied with explicit yes/no, ZERO tasks (resolved).

           When in doubt, KEEP the task — a duplicate is worse than
           a dropped follow-up.

  Step 3 — Read the session as a whole. Voice notes about the same
           topic should be combined into ONE task per concrete
           deliverable, not one task per voice note. A 4-minute
           rambling brief is one task ("Produce X"), not four.

  Step 4 — Look at "Existing open Injaz tasks for this client". For
           each candidate finding, ask: is this work already on the
           board? Same deliverable + same client + same intent ⇒
           UPDATE the existing task, do NOT create a duplicate.

  Step 5 — Look at "Past sessions for this contact". Have we
           discussed this before? If a prior session produced a task
           with the same title, prefer UPDATE-ing that one.

  Step 6 — Look at "Active projects for this client". When setting
           projectName, prefer a project with related open tasks
           over a generic "General Operations" bucket.

  Step 7 — Look at "Assignee workload". When the conversation
           doesn't name an assignee, prefer the approved employee
           with the lowest open-task count whose role fits (e.g.
           design tasks → designers, finance tasks → finance).

  Step 8 — Write the task title in the format
           "[Action verb] [deliverable] for {client name}
            (contact: {person name})"
           e.g. "Send revised PPP draft v3 for e&
                  (contact: Mirna Sherif)".
           If there's no client/contact, omit those parens — but
           if you DO know them from the context, you MUST include
           them.

  Step 9 — Write the description like a brief: specific deliverable,
           any numbers/dates the client gave, the next physical
           action. Avoid vague verbs like "follow up" — prefer
           "Send revised PPP draft v3 with the updated activity
           timeline by 2026-04-29 morning". Reference the corrected
           Whisper names, not the raw transcript spelling.

Hard rules you must NEVER violate:
  - You never send messages to clients directly. Everything you produce is
    a proposal for Islam to approve.
  - You never invent facts. Every task you propose MUST cite at least one
    evidence quote from the session with its interactionId.
  - You never create a task if no follow-up is needed. Returning zero tasks
    is the right answer when the conversation was chitchat, already
    resolved (Islam already replied/sent), or information-only.
  - Tasks must be actionable by ONE person within a week. Split anything
    bigger; omit anything vaguer.
  - If due date is genuinely unclear, set dueDateGuess to null. Do not
    guess from vibes.
  - Write tasks in the language the client used (if they wrote in Arabic,
    write the task in Arabic). Title/description in the original language;
    proper names always in their canonical (Known clients/employees) form.
  - existingInjazTaskId MUST come from the "Existing open Injaz tasks"
    block — never invent an id.

NEW-CLIENT rule (createNewClient):
  - Set this ONLY when the conversation NAMES a client (company, brand,
    person buying from us) that is NOT in the Known-Clients block AND
    the message is clearly business-related.
  - Use the canonical brand name as written in the conversation — same
    capitalisation. Example: "Sodic", "ABB", "Saudi German".
  - Never set this for vendors, suppliers, internal team members, or
    family-style chitchat. CLIENT only.
  - If you set createNewClient, you typically should also set
    createNewProject (a fresh client probably doesn't have a project yet).

NEW-PROJECT rule (createNewProject):
  - Set this when the conversation is about a NEW deliverable scope
    that doesn't fit any of the "Active projects for this client".
    Example: client has projects "e& Culture" and "Anti-Money
    Laundering Video", and the conversation is about a brand new
    "Q3 Sales Conference" — set createNewProject="Q3 Sales Conference".
  - Use a short noun phrase, no verbs. Title-case.
  - If you DO set createNewProject, do NOT also set the existing
    "projectName" field for the task (the sync will use the new
    project's name automatically).
  - Leave null when you'd attach the task to an existing project.

START-DATE-vs-DUE-DATE:
  - startDateGuess = when WORK should begin. Set when the client asked
    for a specific start ("نبدأ السبت", "kickoff Monday").
  - dueDateGuess = when work must be FINISHED. Set when the client
    gave a deadline ("لازم بكره", "by end of week").
  - Both can be null. Only set what the conversation actually
    specified — never guess from vibes.`;

const OUTPUT_CONTRACT = `You must respond with ONLY a single JSON object matching this TypeScript type:

{
  "summary": string,          // optional 1–3 sentence summary of the session
  "proposedTasks": Array<{
    "title": string,          // ≤ 200 chars, imperative — "[Verb] [deliverable] for {client} (contact: {person})"
    "description": string,    // ≤ 4000 chars; what exactly to do, numbers/dates, next physical action
    "priority": "low" | "med" | "high" | "urgent",
    "assigneeGuess": string | null,         // canonical name from Known Employees, else null
    "startDateGuess": string | null,        // ISO 8601 — when work should START, or null
    "dueDateGuess": string | null,          // ISO 8601 — when it must be DONE, or null
    "existingInjazTaskId": string | null,   // UPDATE existing? id from Existing-Tasks block, else null
    "createNewClient": string | null,       // see NEW-CLIENT rule below
    "createNewProject": string | null,      // see NEW-PROJECT rule below
    "rationale": string,                     // why this task is the right call
    "evidence": Array<{
      "interactionId": string,               // uuid from the input
      "quote": string                        // exact phrase from the session
    }>
  }>
}

Output rules:
  - Return STRICTLY valid JSON. No prose, no markdown, no code fences.
  - evidence MUST reference real interactionIds from this session.
  - If there is no follow-up, return { "proposedTasks": [] }.

CREATE-vs-UPDATE rule (CRITICAL — read carefully):
  - If the input includes an "Existing open Injaz tasks" block, scan it
    before producing each proposedTask.
  - If the new finding is clearly the SAME piece of work as one of
    those existing tasks (same deliverable, same client, same intent),
    set "existingInjazTaskId" to that task's id and write
    title/description as the UPDATED version (e.g. revised due date,
    new sub-points, status change). Do NOT duplicate.
  - If the new finding is genuinely a separate task, leave
    "existingInjazTaskId" as null. New work goes through a fresh
    create_task in Injaz.
  - When in doubt, prefer UPDATE — duplicate tasks are worse than
    one slightly-too-broad task.`;

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
  const header = `=== SESSION ===
Session ${ctx.sessionId} (opened ${ctx.openedAt}, last activity ${ctx.lastActivityAt}).`;

  const contactBlock = `=== CONTACT ===
${buildContactHeader(ctx)}`;

  const interactionLines = ctx.interactions.map((i, idx) => {
    const body =
      i.transcriptText && i.transcriptText.length > 0
        ? `[transcript] ${i.transcriptText}`
        : (i.text ?? '(no text body)');
    return `[${idx + 1}] id=${i.id} ${i.channel}/${i.contentType} (${i.direction}) @ ${i.occurredAt}\n    ${body.replace(/\n/g, '\n    ')}`;
  });
  const interactionsBlock = `=== INTERACTIONS (chronological) ===
${interactionLines.join('\n')}`;

  const sections: string[] = [header, '', contactBlock, '', interactionsBlock];

  const existing = ctx.existingInjazTasks ?? [];
  if (existing.length > 0) {
    const lines: string[] = [`=== EXISTING OPEN INJAZ TASKS (${existing.length}) ===`];
    for (const t of existing) {
      const meta = [
        t.priority ? `priority=${t.priority}` : null,
        t.assigneeName ? `assignee=${t.assigneeName}` : null,
        t.projectName ? `project=${t.projectName}` : null,
        t.dueDate ? `due=${t.dueDate}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      const desc = t.description ? `\n    ${t.description.replace(/\n/g, '\n    ').slice(0, 400)}` : '';
      lines.push(`- id=${t.id} status=${t.status}${meta ? ` (${meta})` : ''}\n    "${t.title}"${desc}`);
    }
    sections.push('', lines.join('\n'));
  }

  const projects = ctx.clientProjects ?? [];
  if (projects.length > 0) {
    const lines: string[] = [`=== ACTIVE PROJECTS FOR THIS CLIENT (${projects.length}) ===`];
    for (const p of projects) {
      const desc = p.description ? ` — ${p.description.replace(/\n/g, ' ').slice(0, 120)}` : '';
      const lead = p.leadAssigneeName ? ` lead=${p.leadAssigneeName}` : '';
      lines.push(
        `- "${p.name}" (${p.openTaskCount} open task${p.openTaskCount === 1 ? '' : 's'}${lead})${desc}`,
      );
    }
    sections.push('', lines.join('\n'));
  }

  const workload = ctx.assigneeWorkload ?? [];
  if (workload.length > 0) {
    const lines = [`=== ASSIGNEE WORKLOAD (use to suggest least-loaded employee) ===`];
    for (const w of workload) {
      lines.push(`- ${w.name}: ${w.openTasks} open task${w.openTasks === 1 ? '' : 's'}`);
    }
    sections.push('', lines.join('\n'));
  }

  const past = ctx.pastSessions ?? [];
  if (past.length > 0) {
    const lines = [`=== PAST SESSIONS WITH THIS CONTACT (${past.length}) ===`];
    for (const s of past) {
      const head = `- ${s.openedAt} (${s.state})${s.summary ? ` — ${s.summary.slice(0, 200)}` : ''}`;
      lines.push(head);
      for (const t of s.proposedTitles) {
        lines.push(`    · ${t.state}: ${t.title}`);
      }
    }
    sections.push('', lines.join('\n'));
  }

  // Company snapshot — known clients (with canonical name + the
  // contact person Injaz has) and known employees (with role). Sits
  // BELOW the conversation-specific blocks because the model should
  // only consult it when it sees a name that needs correcting or
  // when picking an assignee. Keeping it always-on costs ~500 tokens
  // but the latency hit is dwarfed by reasoning time.
  const clients = ctx.knownClients ?? [];
  if (clients.length > 0) {
    const lines = [
      `=== KNOWN CLIENTS (canonical names — use these spellings; correct Whisper drift) ===`,
    ];
    for (const c of clients) {
      const meta = [
        c.contactName ? `contact: ${c.contactName}` : null,
        c.email ? `email: ${c.email}` : null,
        c.phone ? `phone: ${c.phone}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- "${c.name}"${meta ? ` (${meta})` : ''}`);
    }
    sections.push('', lines.join('\n'));
  }

  const employees = ctx.knownEmployees ?? [];
  if (employees.length > 0) {
    const lines = [`=== KNOWN EMPLOYEES (use canonical name in assigneeGuess) ===`];
    for (const e of employees) {
      lines.push(`- "${e.name}" (${e.role}${e.email ? `, ${e.email}` : ''})`);
    }
    sections.push('', lines.join('\n'));
  }

  return sections.join('\n');
}

// ---- Main entry ---------------------------------------------------------

export interface ReasonCallResult {
  output: ReasonOutput;
  rawResponse: Anthropic.Messages.Message | OpenAI.Chat.Completions.ChatCompletion;
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
  provider?: 'anthropic' | 'openai';
}): Promise<ReasonCallResult> {
  const {
    apiKey,
    model = DEFAULT_REASONING_MODEL,
    context,
    // 4096 leaves room for chain-of-thought-ish output when the AI
    // produces 3-5 detailed task descriptions.
    maxTokens = 4096,
    provider = 'openai',
  } = args;

  if (provider === 'openai') {
    return reasonOverSessionOpenAI({ apiKey, model: model || DEFAULT_REASONING_MODEL, context, maxTokens });
  }

  return reasonOverSessionAnthropic({ apiKey, model, context, maxTokens });
}

async function reasonOverSessionAnthropic(args: {
  apiKey: string;
  model: string;
  context: ReasonContext;
  maxTokens: number;
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

async function reasonOverSessionOpenAI(args: {
  apiKey: string;
  model: string;
  context: ReasonContext;
  maxTokens: number;
}): Promise<ReasonCallResult> {
  const { apiKey, model = DEFAULT_REASONING_MODEL, context, maxTokens = 4096 } = args;

  // Route to DeepSeek for `deepseek-*` models, OpenAI for everything
  // else. Both speak the same chat-completions wire format so the
  // request payload below is identical — only the bearer + base URL
  // differ.
  const { client, provider } = getReasoningClient({ model, openaiKey: apiKey });
  const userBody = buildSessionBody(context);

  const start = Date.now();
  // DeepSeek's "thinking mode" gives the model up to ~32K reasoning
  // tokens (not billed as output) before it produces the final JSON.
  // Worth it for the multi-step decisions Nexus makes.
  const extraBody =
    provider === 'deepseek'
      ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
      : undefined;

  // Build the request with DeepSeek's extra fields tucked into the
  // body via `as Record<string, unknown>` — the OpenAI SDK strips
  // unknown keys at the type level but forwards them in the JSON
  // payload, which is exactly what DeepSeek's compat shim reads.
  const requestBody: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'system',
        content: `${NEXUS_PERSONA}\n\n${OUTPUT_CONTRACT}`,
      },
      {
        role: 'user',
        content: userBody,
      },
    ],
    response_format: { type: 'json_object' },
    stream: false,
  };
  if (extraBody) {
    Object.assign(requestBody as unknown as Record<string, unknown>, extraBody);
  }
  const response = await client.chat.completions.create(requestBody);
  const latencyMs = Date.now() - start;

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('OpenAI response had no content');
  }

  let parsed: ReasonOutput;
  try {
    const jsonish = JSON.parse(raw);
    parsed = reasonOutputSchema.parse(jsonish);
  } catch (err) {
    throw new Error(
      `reason output invalid: ${(err as Error).message}\nraw: ${raw.slice(0, 500)}`,
    );
  }

  const usage = response.usage;
  if (!usage) {
    throw new Error('OpenAI response missing usage data');
  }

  const costUsd = computeOpenAICostUsd({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    model,
  });

  return {
    output: parsed,
    rawResponse: response,
    costUsd,
    tokensIn: usage.prompt_tokens,
    tokensOut: usage.completion_tokens,
    latencyMs,
  };
}
