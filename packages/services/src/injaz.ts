/**
 * Injaz client.
 *
 * Injaz exposes an **MCP-over-SSE** endpoint at `${INJAZ_MCP_URL}`
 * (default `${INJAZ_API_BASE}/mcp/sse`). The legacy REST adapter is
 * retained for `getInjazTask` / `updateInjazTask` (which Injaz might
 * still expose), but `createInjazTask` now drives the MCP `create_task`
 * tool. Discovered tool names: list_payments, get_payment,
 * create_payment, list_parties, create_party, list_documents,
 * create_document, list_tasks, **create_task**, update_task,
 * list_projects, …
 *
 * MCP handshake:
 *   1. GET /mcp/sse → server keeps stream open + emits `endpoint` event
 *      with a per-session URL like `/mcp/message?sessionId=…`.
 *   2. POST `initialize` to that endpoint (response arrives over SSE).
 *   3. POST `notifications/initialized` (no response).
 *   4. POST `tools/call` with name=create_task + args.
 *   5. Close SSE.
 *
 * Errors:
 *   - HTTP 5xx during MCP handshake → retryable.
 *   - JSON-RPC error response → permanent failure (4xx-equivalent).
 */

export class InjazError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'InjazError';
  }
}

export interface InjazTaskInput {
  title: string;
  description: string;
  priority?: 'low' | 'med' | 'high' | 'urgent';
  dueDate?: string | null;       // ISO 8601
  assignee?: string | null;      // freeform name or email
  externalRefId?: string;        // our proposed_task.id; for idempotency
  source?: string;               // 'nexus'
}

export interface InjazTask extends InjazTaskInput {
  id: string;
  status?: 'open' | 'in_progress' | 'done' | 'cancelled';
  createdAt?: string;
  updatedAt?: string;
}

export interface InjazClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRetryable(status: number): boolean {
  // 408 Request Timeout, 425 Too Early, 429 Too Many, 5xx
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function call<T>(
  opts: InjazClientOptions,
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const url = new URL(path.replace(/^\//, ''), opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.apiKey}`,
      'user-agent': 'nexus/1.0',
      'content-type': 'application/json',
      accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

    const res = await fetchImpl(url.toString(), {
      ...init,
      signal: ctrl.signal,
      headers,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new InjazError(
        `injaz ${path} failed: ${res.status} ${body.slice(0, 500)}`,
        res.status,
        isRetryable(res.status),
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof InjazError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new InjazError(`injaz ${path} timeout after ${timeoutMs}ms`, 0, true);
    }
    throw new InjazError(`injaz ${path} network error: ${(err as Error).message}`, 0, true);
  } finally {
    clearTimeout(timer);
  }
}

export async function createInjazTask(
  opts: InjazClientOptions,
  task: InjazTaskInput,
): Promise<InjazTask> {
  // Injaz MCP `create_task` tool — input shape:
  //   { title, description?, status?, priority? ('High'|'Medium'|'Low'),
  //     projectName?, assigneeName?, dueDate?, startDate? }
  const args: Record<string, unknown> = {
    title: task.title,
    description: task.description,
  };
  if (task.priority) args.priority = mapPriorityToInjaz(task.priority);
  if (task.dueDate) args.dueDate = task.dueDate;
  if (task.assignee) args.assigneeName = task.assignee;

  const sseUrl = mcpSseUrl(opts);
  const result = await mcpToolsCall(sseUrl, opts.apiKey, 'create_task', args);

  // MCP tools usually return `{ content: [{ type:'text', text:'...' }, ...] }`
  // Try to extract the new task id from the structured content if present;
  // fall back to a stable surrogate so upstream code has SOMETHING to store.
  const id = extractTaskId(result) ?? `injaz:${task.externalRefId ?? Date.now()}`;
  return {
    id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueDate: task.dueDate,
    assignee: task.assignee,
  };
}

function mapPriorityToInjaz(p: 'low' | 'med' | 'high' | 'urgent'): string {
  // Injaz enum is 'High' | 'Medium' | 'Low' (capitalized). Map 'urgent' to
  // 'High' since Injaz doesn't have an urgent tier.
  if (p === 'low') return 'Low';
  if (p === 'med') return 'Medium';
  return 'High'; // high or urgent
}

function mcpSseUrl(opts: InjazClientOptions): string {
  // Prefer explicit INJAZ_MCP_URL; fall back to baseUrl + /mcp/sse.
  const explicit = process.env.INJAZ_MCP_URL?.trim();
  if (explicit) return explicit;
  const base = opts.baseUrl.replace(/\/+$/, '');
  return `${base}/mcp/sse`;
}

function extractTaskId(mcpResult: unknown): string | null {
  if (!mcpResult || typeof mcpResult !== 'object') return null;
  const r = mcpResult as Record<string, unknown>;
  // Common MCP shapes: { content: [{type:'text', text:'...'}] } or
  // { structuredContent: { id: '...' } } or directly { id: '...' }.
  if (typeof r.id === 'string') return r.id;
  const sc = r.structuredContent as Record<string, unknown> | undefined;
  if (sc && typeof sc.id === 'string') return sc.id;
  const content = r.content as Array<{ type?: string; text?: string }> | undefined;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text' && typeof c.text === 'string') {
        // Try to parse JSON out of the text block.
        try {
          const parsed = JSON.parse(c.text) as Record<string, unknown>;
          if (typeof parsed.id === 'string') return parsed.id;
          if (parsed.task && typeof (parsed.task as Record<string, unknown>).id === 'string') {
            return (parsed.task as Record<string, unknown>).id as string;
          }
        } catch {
          // Match a UUID-ish or short id substring.
          const m = c.text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|TASK-\d+|task_\w+)\b/);
          if (m) return m[1] ?? null;
        }
      }
    }
  }
  return null;
}

/**
 * Minimal MCP-over-SSE client. Opens an SSE connection, performs the
 * MCP handshake, calls a single tool, and tears down. Suited for
 * Vercel serverless one-shot invocations where keeping a long-lived
 * MCP session would be wasteful.
 */
async function mcpToolsCall(
  sseUrl: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<unknown> {
  const fetchImpl = fetch;
  const sseRes = await fetchImpl(sseUrl, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'text/event-stream',
      'user-agent': 'nexus/1.0',
    },
  });
  if (!sseRes.ok || !sseRes.body) {
    throw new InjazError(
      `mcp sse open failed: ${sseRes.status}`,
      sseRes.status,
      sseRes.status >= 500,
    );
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let endpoint: string | null = null;
  const responses = new Map<number, (msg: unknown) => void>();
  let nextId = 1;

  // SSE pump (runs until reader closes or we abort).
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let evType = '';
          let data = '';
          for (const ln of event.split('\n')) {
            if (ln.startsWith('event:')) evType = ln.slice(6).trim();
            else if (ln.startsWith('data:')) data += ln.slice(5).trim();
          }
          if (evType === 'endpoint') {
            endpoint = data;
          } else if (data) {
            try {
              const msg = JSON.parse(data) as { id?: number };
              if (typeof msg.id === 'number' && responses.has(msg.id)) {
                responses.get(msg.id)!(msg);
              }
            } catch {
              /* ignore non-JSON event */
            }
          }
        }
      }
    } catch {
      /* stream closed */
    }
  })();

  // Wait for the endpoint event (≤ 5s).
  const endpointDeadline = Date.now() + 5000;
  while (!endpoint && Date.now() < endpointDeadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!endpoint) {
    void pump;
    throw new InjazError('mcp sse: never received endpoint event', 0, true);
  }
  const endpointPath: string = endpoint;

  // The endpoint event is a path; resolve against the SSE URL's origin.
  const sse = new URL(sseUrl);
  const messageUrl = endpointPath.startsWith('http')
    ? endpointPath
    : new URL(endpointPath, `${sse.protocol}//${sse.host}`).toString();

  const send = async (
    method: string,
    params?: Record<string, unknown>,
    expectResponse = true,
  ): Promise<unknown> => {
    const id = nextId++;
    const wait = expectResponse
      ? new Promise<unknown>((resolve, reject) => {
          responses.set(id, resolve);
          setTimeout(() => reject(new InjazError(`mcp ${method} timeout`, 0, true)), timeoutMs);
        })
      : Promise.resolve(null);
    const res = await fetchImpl(messageUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'nexus/1.0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new InjazError(
        `mcp ${method} HTTP ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }
    return wait;
  };

  try {
    const init = (await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nexus', version: '0.1' },
    })) as { error?: { message: string } };
    if (init.error) throw new InjazError(`mcp initialize: ${init.error.message}`, 0, false);

    // notifications/initialized has no response — fire and forget.
    await send('notifications/initialized', undefined, false);

    const callRes = (await send('tools/call', {
      name: toolName,
      arguments: args,
    })) as { result?: unknown; error?: { message: string } };
    if (callRes.error) {
      throw new InjazError(`mcp tools/call ${toolName}: ${callRes.error.message}`, 0, false);
    }
    return callRes.result;
  } finally {
    // Best-effort close.
    void reader.cancel().catch(() => undefined);
  }
}

export async function getInjazTask(
  opts: InjazClientOptions,
  id: string,
): Promise<InjazTask | null> {
  try {
    return await call<InjazTask>(opts, `/tasks/${encodeURIComponent(id)}`, { method: 'GET' });
  } catch (err) {
    if (err instanceof InjazError && err.status === 404) return null;
    throw err;
  }
}

export async function updateInjazTask(
  opts: InjazClientOptions,
  id: string,
  patch: Partial<InjazTaskInput>,
): Promise<InjazTask> {
  return call<InjazTask>(opts, `/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function injazClientFromEnv(): InjazClientOptions | null {
  const baseUrl = process.env.INJAZ_API_BASE;
  const apiKey = process.env.INJAZ_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}
