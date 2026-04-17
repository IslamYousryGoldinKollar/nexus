import { parseServerEnv, type ServerEnv } from '@nexus/shared';

/**
 * Single source of truth for server-side env in apps/web.
 * Parses + freezes on first call. If required vars are missing,
 * this throws — failing fast is the desired behavior.
 *
 * Never import this from client components ("use client").
 */

let _env: ServerEnv | null = null;

export function env(): ServerEnv {
  if (!_env) {
    _env = parseServerEnv(process.env as Record<string, string | undefined>);
  }
  return _env;
}
