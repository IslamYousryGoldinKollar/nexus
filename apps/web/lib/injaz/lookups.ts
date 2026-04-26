import 'server-only';
import {
  injazClientFromEnv,
  listInjazParties,
  listInjazUsers,
  listInjazProjects,
  type InjazParty,
  type InjazUser,
  type InjazProject,
} from '@nexus/services';
import { log } from '@/lib/logger';

/**
 * Process-local TTL cache for the three Injaz list endpoints. Each MCP
 * call costs ~3-5s (SSE handshake + initialize + tools/call), so caching
 * 5 minutes lets the contact-mapping UI feel snappy without staleness
 * the operator would notice.
 *
 * Vercel keeps the warm Node.js worker alive across requests, so the
 * map persists between calls within the same lambda instance. Each cold
 * start re-fetches — that's fine for our scale.
 */
type CacheEntry<T> = { value: T; expiresAt: number };
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function setCached<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function loadInjazClients(force = false): Promise<InjazParty[]> {
  if (!force) {
    const hit = getCached<InjazParty[]>('parties:CLIENT');
    if (hit) return hit;
  }
  const client = injazClientFromEnv();
  if (!client) {
    log.warn('injaz.lookups.no_creds', { kind: 'parties' });
    return [];
  }
  const parties = await listInjazParties(client, 'CLIENT');
  setCached('parties:CLIENT', parties);
  return parties;
}

export async function loadInjazUsers(force = false): Promise<InjazUser[]> {
  if (!force) {
    const hit = getCached<InjazUser[]>('users');
    if (hit) return hit;
  }
  const client = injazClientFromEnv();
  if (!client) {
    log.warn('injaz.lookups.no_creds', { kind: 'users' });
    return [];
  }
  const users = await listInjazUsers(client);
  // Keep only approved users — the rejected ones are stale duplicates
  // (e.g. islamyossry3@gmail.com vs islam.yousry@goldinkollar.com).
  const approved = users.filter((u) => u.approvalStatus === 'approved');
  setCached('users', approved);
  return approved;
}

export async function loadInjazProjects(force = false): Promise<InjazProject[]> {
  if (!force) {
    const hit = getCached<InjazProject[]>('projects:ACTIVE');
    if (hit) return hit;
  }
  const client = injazClientFromEnv();
  if (!client) {
    log.warn('injaz.lookups.no_creds', { kind: 'projects' });
    return [];
  }
  const projects = await listInjazProjects(client, 'ACTIVE');
  setCached('projects:ACTIVE', projects);
  return projects;
}
