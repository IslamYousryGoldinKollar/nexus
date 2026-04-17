import { inngest } from '../client.js';

/**
 * Phase 0 hello-world — proves the Inngest pipeline is wired end-to-end.
 * Emits a log line and returns the payload. Delete or repurpose in Phase 1.
 */
export const hello = inngest.createFunction(
  { id: 'hello', name: 'Hello Nexus (scaffolding check)' },
  { event: 'nexus/system.error' },
  async ({ event, step }) => {
    await step.run('log', async () => {
      // eslint-disable-next-line no-console
      console.log('[inngest/hello] received', {
        source: event.data.source,
        message: event.data.message,
      });
      return { ok: true };
    });
    return { received: event.data };
  },
);
