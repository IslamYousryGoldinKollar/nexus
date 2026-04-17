import { parseServerEnv, type ServerEnv } from '@nexus/shared';

/**
 * Single source of truth for server-side env in apps/web.
 *
 * Lazy-parsed on first property access, frozen after. Never import this
 * from a client component — it would fail the build, but keep vigilance.
 *
 * Usage:
 *   ```ts
 *   import { serverEnv } from '@/lib/env';
 *   const apiKey = serverEnv.ANTHROPIC_API_KEY;
 *   ```
 *
 * Also exposed as `env()` for call sites that prefer explicit invocation.
 */

let _env: ServerEnv | null = null;

export function env(): ServerEnv {
  if (!_env) {
    _env = parseServerEnv(process.env as Record<string, string | undefined>);
  }
  return _env;
}

/**
 * Proxy that lazily parses and returns env vars on property access.
 * Delays the fail-fast check until *any* var is read — which is always
 * before we actually need the var at runtime.
 */
export const serverEnv = new Proxy({} as ServerEnv, {
  get(_t, prop: string | symbol) {
    return env()[prop as keyof ServerEnv];
  },
  has(_t, prop: string | symbol) {
    return prop in env();
  },
  ownKeys() {
    return Reflect.ownKeys(env());
  },
  getOwnPropertyDescriptor(_t, prop: string | symbol) {
    return Object.getOwnPropertyDescriptor(env(), prop);
  },
});
