import { hello } from './hello.js';
import { notifyOnProposal } from './notify-on-proposal.js';
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
 * Phase 9: + notify-on-proposal
 */
export const functions = [
  hello,
  resolveAndAttach,
  onSessionCooldown,
  sessionSweep,
  transcribeAttachment,
  reasonSession,
  syncToInjaz,
  notifyOnProposal,
] as const;

export {
  hello,
  notifyOnProposal,
  onSessionCooldown,
  reasonSession,
  resolveAndAttach,
  sessionSweep,
  syncToInjaz,
  transcribeAttachment,
};
