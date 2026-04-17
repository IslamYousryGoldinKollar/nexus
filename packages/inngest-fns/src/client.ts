import { EventSchemas, Inngest } from 'inngest';
import type {
  IdentifierSeenEvent,
  InjazSyncRequestedEvent,
  InteractionIngestedEvent,
  ProposalCreatedEvent,
  SessionCooldownHeartbeatEvent,
  SessionReasoningRequestedEvent,
  SystemErrorEvent,
  TranscriptionRequestedEvent,
} from '@nexus/shared';

/**
 * Inngest client — singleton used by the Next.js serve endpoint
 * and by any code that emits events.
 */

type Events = {
  'nexus/interaction.ingested': InteractionIngestedEvent;
  'nexus/identifier.seen': IdentifierSeenEvent;
  'nexus/session.cooldown.heartbeat': SessionCooldownHeartbeatEvent;
  'nexus/session.reasoning.requested': SessionReasoningRequestedEvent;
  'nexus/proposal.created': ProposalCreatedEvent;
  'nexus/transcription.requested': TranscriptionRequestedEvent;
  'nexus/injaz.sync.requested': InjazSyncRequestedEvent;
  'nexus/system.error': SystemErrorEvent;
};

export const inngest = new Inngest({
  id: 'nexus',
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type NexusInngest = typeof inngest;
