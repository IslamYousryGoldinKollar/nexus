import { hello } from './hello.js';
import { reasonSession } from './reason-session.js';
import { resolveAndAttach } from './resolve-and-attach.js';
import { onSessionCooldown, sessionSweep } from './session-cooldown.js';
import { syncToInjaz } from './sync-to-injaz.js';
import { transcribeAttachment } from './transcribe-attachment.js';

/**
 * All Inngest functions the web app registers with the serve endpoint.
 *
 * Phase 1: resolve-and-attach (id=interaction-ingested)
 * Phase 2: + session-cooldown / session-sweep
 * Phase 3: + transcribe-attachment
 * Phase 4: + reason-session
 * Phase 6: + sync-to-injaz
 */
export const functions = [
  hello,
  resolveAndAttach,
  onSessionCooldown,
  sessionSweep,
  transcribeAttachment,
  reasonSession,
  syncToInjaz,
] as const;

export {
  hello,
  onSessionCooldown,
  reasonSession,
  resolveAndAttach,
  sessionSweep,
  syncToInjaz,
  transcribeAttachment,
};
