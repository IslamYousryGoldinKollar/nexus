import { inngest } from '../client.js';

/**
 * Phase 1 handler for `nexus/interaction.ingested`.
 *
 * Today this is a pure logger — enough to prove that every webhook round-
 * trips through Inngest and lands in the durable-workflow audit trail.
 *
 * Phase 2 replaces the step bodies with:
 *   1. `resolveIdentity` — match or queue a pending_identifier
 *   2. `attachToSession` — open or extend a Session (state machine)
 *   3. `scheduleReasoning` — debounce + emit session.reasoning.requested
 *
 * We keep the function id stable across phases so Inngest treats every
 * subsequent deploy as an update, not a net-new function.
 */
export const onInteractionIngested = inngest.createFunction(
  { id: 'interaction-ingested', name: 'On interaction.ingested (Phase 1: log)' },
  { event: 'nexus/interaction.ingested' },
  async ({ event, step }) => {
    await step.run('log', async () => {
      const line = {
        phase: 1,
        event: 'nexus/interaction.ingested',
        interactionId: event.data.interactionId,
        channel: event.data.channel,
        sourceMessageId: event.data.sourceMessageId,
        occurredAt: event.data.occurredAt,
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(line));
      return line;
    });
    return { status: 'logged' };
  },
);
