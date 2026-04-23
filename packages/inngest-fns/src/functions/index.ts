import { dailyDigest } from './daily-digest.js';
import { hello } from './hello.js';
import { notifyOnProposal } from './notify-on-proposal.js';
import { notificationRouter } from './notification-router.js';
import { processGmailNotification } from './process-gmail-notification.js';
import { reasonSession } from './reason-session.js';
import { resolveAndAttach } from './resolve-and-attach.js';
import { onSessionCooldown, sessionSweep } from './session-cooldown.js';
import { syncToInjaz } from './sync-to-injaz.js';
import { telegramFallback } from './telegram-fallback.js';
import { transcribeAttachment } from './transcribe-attachment.js';
import { budgetMonitor } from './budget-monitor.js';

/**
 * All Inngest functions the web app registers with the serve endpoint.
 *
 * Phase 1: resolve-and-attach (id=interaction-ingested)
 * Phase 2: + session-cooldown / session-sweep
 * Phase 3: + transcribe-attachment
 * Phase 4: + reason-session
 * Phase 6: + sync-to-injaz
 * Phase 9: + notify-on-proposal, notification-router, telegram-fallback
 * Phase 11: + daily-digest, budget-monitor
 * Phase 1.5: + process-gmail-notification
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
  dailyDigest,
  processGmailNotification,
  notificationRouter,
  telegramFallback,
  budgetMonitor,
] as const;

export {
  dailyDigest,
  hello,
  notifyOnProposal,
  onSessionCooldown,
  processGmailNotification,
  reasonSession,
  resolveAndAttach,
  sessionSweep,
  syncToInjaz,
  transcribeAttachment,
  notificationRouter,
  telegramFallback,
  budgetMonitor,
};
