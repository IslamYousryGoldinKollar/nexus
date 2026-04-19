/**
 * Injaz REST/MCP client.
 *
 * Phase 6 ships with a thin REST adapter that calls
 * `${INJAZ_API_BASE}/tasks`. The MCP-over-SSE endpoint is left
 * pluggable: once Injaz exposes a stable MCP schema we swap the
 * `createTask` impl without touching the Inngest function.
 *
 * All calls send `Authorization: Bearer ${INJAZ_API_KEY}` and a
 * `User-Agent: nexus/1.0` header so Injaz can audit per-source traffic.
 *
 * Error handling: HTTP 5xx → retryable; 4xx → permanent failure (logged
 * + returned to caller, never retried).
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
  return call<InjazTask>(opts, '/tasks', {
    method: 'POST',
    body: JSON.stringify({
      ...task,
      source: task.source ?? 'nexus',
    }),
    // Idempotency-Key prevents double-creation if our retry races with a
    // late 200 from a previous attempt.
    ...(task.externalRefId ? { idempotencyKey: task.externalRefId } : {}),
  });
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
