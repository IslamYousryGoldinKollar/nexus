import { hello } from './hello.js';
import { resolveAndAttach } from './resolve-and-attach.js';
import { onSessionCooldown, sessionSweep } from './session-cooldown.js';
import { transcribeAttachment } from './transcribe-attachment.js';

/**
 * All Inngest functions the web app should register with the serve endpoint.
 *
 * Phase 1 had a placeholder logger for `interaction.ingested`; Phase 2
 * replaced it with `resolveAndAttach` (same function id). Phase 3 adds
 * `transcribeAttachment` which runs in parallel with session attachment.
 */
export const functions = [
  hello,
  resolveAndAttach,
  onSessionCooldown,
  sessionSweep,
  transcribeAttachment,
] as const;

export {
  hello,
  onSessionCooldown,
  resolveAndAttach,
  sessionSweep,
  transcribeAttachment,
};
