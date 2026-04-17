import { hello } from './hello.js';
import { resolveAndAttach } from './resolve-and-attach.js';
import { onSessionCooldown, sessionSweep } from './session-cooldown.js';

/**
 * All Inngest functions the web app should register with the serve endpoint.
 *
 * Phase 1 had a placeholder `onInteractionIngested` logger — Phase 2 replaces
 * it with `resolveAndAttach` (same function id = 'interaction-ingested' so
 * Inngest treats it as an update, not a new function).
 */
export const functions = [
  hello,
  resolveAndAttach,
  onSessionCooldown,
  sessionSweep,
] as const;

export { hello, onSessionCooldown, resolveAndAttach, sessionSweep };
