import {
  proto,
  initAuthCreds,
  BufferJSON,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import { log } from './logger.js';
import { listAuthFiles, readAuthFile, writeAuthFile } from './storage.js';

/**
 * Remote-first Baileys auth store.
 *
 * Baileys ships `useMultiFileAuthState(dir)` which reads/writes many small
 * JSON files. Those files are the long-lived session — if we lose them we
 * must re-pair. Ephemeral containers (Fly machines, Railway services) can
 * wipe disk on any deploy, so we mirror to Supabase Storage.
 *
 * Strategy:
 *   - On boot: pull every file from Storage → `env.authDir`.
 *   - On `saveCreds()` or on any `keys.set`: write through to Storage.
 *   - Disk is a fast cache; Storage is the source of truth.
 *
 * The API is the same shape as `useMultiFileAuthState` so it's a drop-in.
 */

function fileKey(category: string, id?: string): string {
  const safe = (s: string) => s.replace(/\//g, '__');
  return id ? `${category}-${safe(id)}.json` : `${safe(category)}.json`;
}

async function hydrateFromRemote(): Promise<void> {
  if (!existsSync(env.authDir)) await mkdir(env.authDir, { recursive: true });
  const files = await listAuthFiles().catch((err) => {
    log.warn({ err: (err as Error).message }, 'auth.list.failed');
    return [] as string[];
  });
  if (files.length === 0) {
    log.info('auth.hydrate.empty (first boot — will pair)');
    return;
  }
  for (const name of files) {
    const bytes = await readAuthFile(name);
    if (!bytes) continue;
    await writeFile(join(env.authDir, name), Buffer.from(bytes));
  }
  log.info({ count: files.length }, 'auth.hydrate.done');
}

async function writeJsonBoth(name: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, BufferJSON.replacer);
  const bytes = Buffer.from(serialized, 'utf8');
  await writeFile(join(env.authDir, name), bytes);
  // Mirror to remote — best-effort; we won't block message handling on a
  // transient Storage hiccup.
  writeAuthFile(name, new Uint8Array(bytes)).catch((err) => {
    log.warn({ name, err: (err as Error).message }, 'auth.remote.write.failed');
  });
}

async function readJsonLocal<T>(name: string): Promise<T | null> {
  const path = join(env.authDir, name);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw, BufferJSON.reviver) as T;
}

/**
 * Factory mirroring Baileys' `useMultiFileAuthState` contract.
 */
export async function useRemoteAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  await hydrateFromRemote();

  const credsName = fileKey('creds');
  const creds: AuthenticationCreds =
    (await readJsonLocal<AuthenticationCreds>(credsName)) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        await Promise.all(
          ids.map(async (id) => {
            const name = fileKey(type, id);
            const v = await readJsonLocal<unknown>(name);
            if (!v) return;
            // `app-state-sync-key` needs proto reconstruction; the JSON on
            // disk is a plain object, but Baileys expects a proto instance.
            // All other categories are plain KeyPair/Uint8Array records.
            if (type === 'app-state-sync-key') {
              out[id] = proto.Message.AppStateSyncKeyData.fromObject(
                v as unknown as proto.Message.AppStateSyncKeyData,
              ) as unknown as SignalDataTypeMap[typeof type];
            } else {
              out[id] = v as SignalDataTypeMap[typeof type];
            }
          }),
        );
        return out;
      },
      set: async (data) => {
        const tasks: Promise<void>[] = [];
        for (const category in data) {
          const cat = category as keyof SignalDataTypeMap;
          const byId = data[cat];
          if (!byId) continue;
          for (const id in byId) {
            const value = (byId as Record<string, unknown>)[id];
            const name = fileKey(cat, id);
            if (value) {
              tasks.push(writeJsonBoth(name, value));
            }
            // Deletion: skip in-place to keep audit trail; Baileys cycles
            // pre-keys aggressively and Storage `remove` is slower than a
            // stale file sitting unused.
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  const saveCreds = async () => writeJsonBoth(credsName, state.creds);
  return { state, saveCreds };
}
