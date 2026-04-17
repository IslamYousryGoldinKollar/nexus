import { z } from 'zod';
import { CHANNELS, IDENTIFIER_KINDS } from './channels.js';

/**
 * Inngest event schemas. Every event payload is validated with Zod
 * before being emitted or consumed. Adding a new event? Add its schema here
 * and the corresponding handler in packages/inngest-fns.
 */

// Fired by every ingestion webhook after persisting a row in `interactions`.
export const interactionIngestedEvent = z.object({
  name: z.literal('nexus/interaction.ingested'),
  data: z.object({
    interactionId: z.string().uuid(),
    channel: z.enum(CHANNELS),
    sourceMessageId: z.string(),
    occurredAt: z.string().datetime(),
  }),
});
export type InteractionIngestedEvent = z.infer<typeof interactionIngestedEvent>;

// Emitted when a raw identifier is seen but not yet resolved to a contact.
export const identifierSeenEvent = z.object({
  name: z.literal('nexus/identifier.seen'),
  data: z.object({
    kind: z.enum(IDENTIFIER_KINDS),
    value: z.string(),
    interactionId: z.string().uuid(),
  }),
});
export type IdentifierSeenEvent = z.infer<typeof identifierSeenEvent>;

// Fired when a session transitions AGGREGATING → REASONING.
export const sessionReasoningRequestedEvent = z.object({
  name: z.literal('nexus/session.reasoning.requested'),
  data: z.object({
    sessionId: z.string().uuid(),
    trigger: z.enum(['silence_timeout', 'manual', 'cron', 'command']),
  }),
});
export type SessionReasoningRequestedEvent = z.infer<typeof sessionReasoningRequestedEvent>;

// Fired when Claude has produced proposed tasks and they are ready for HITL.
export const proposalCreatedEvent = z.object({
  name: z.literal('nexus/proposal.created'),
  data: z.object({
    sessionId: z.string().uuid(),
    reasoningRunId: z.string().uuid(),
    proposedTaskIds: z.array(z.string().uuid()),
  }),
});
export type ProposalCreatedEvent = z.infer<typeof proposalCreatedEvent>;

// Fired when an audio/video attachment is ready to transcribe.
export const transcriptionRequestedEvent = z.object({
  name: z.literal('nexus/transcription.requested'),
  data: z.object({
    attachmentId: z.string().uuid(),
    interactionId: z.string().uuid(),
    preferredProvider: z.enum(['whisper', 'assemblyai']).optional(),
  }),
});
export type TranscriptionRequestedEvent = z.infer<typeof transcriptionRequestedEvent>;

// Fired when a proposed task is approved and needs syncing to Injaz.
export const injazSyncRequestedEvent = z.object({
  name: z.literal('nexus/injaz.sync.requested'),
  data: z.object({
    proposedTaskId: z.string().uuid(),
  }),
});
export type InjazSyncRequestedEvent = z.infer<typeof injazSyncRequestedEvent>;

// Heartbeat fired on every new interaction attached to a session.
// The `onSessionCooldown` Inngest function is configured to DEBOUNCE on
// this event keyed by sessionId — so if another heartbeat arrives within
// the cooldown window, the timer resets. After N minutes of silence the
// handler emits `nexus/session.reasoning.requested`.
export const sessionCooldownHeartbeatEvent = z.object({
  name: z.literal('nexus/session.cooldown.heartbeat'),
  data: z.object({
    sessionId: z.string().uuid(),
    interactionId: z.string().uuid(),
  }),
});
export type SessionCooldownHeartbeatEvent = z.infer<typeof sessionCooldownHeartbeatEvent>;

// Generic error event — any pipeline stage can emit this.
export const systemErrorEvent = z.object({
  name: z.literal('nexus/system.error'),
  data: z.object({
    source: z.string(), // 'ingest.whatsapp' | 'inngest.reason' | ...
    sessionId: z.string().uuid().optional(),
    interactionId: z.string().uuid().optional(),
    message: z.string(),
    stack: z.string().optional(),
  }),
});
export type SystemErrorEvent = z.infer<typeof systemErrorEvent>;
